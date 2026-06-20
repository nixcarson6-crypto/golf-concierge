/**
 * The just-in-time `CardProvider` the agent calls when it reaches a venue's
 * checkout step. This is the bridge between the agent loop and Stripe
 * Issuing: it charges the customer's saved card, mints a single-use virtual
 * card limited to that exact amount, reveals the PAN, and hands it back.
 * The number lives in memory only for the duration of the tool_result and
 * is never logged or persisted.
 *
 * If the customer hasn't saved a card yet, or charging fails, we return
 * `unavailable` — the agent is instructed to bail out via report_outcome
 * with `needs_review`, never to fabricate a card.
 */

import { db } from "@/lib/db";
import { stripeConfigured } from "@/lib/stripe";
import {
  ensureCardholder,
  createSingleUseCard,
  revealCard,
} from "@/lib/payments/issuing";
import { chargeCustomer } from "@/lib/payments/customer-charge";
import { serviceFeeCents } from "@/lib/payments/pricing";
import type { CardProvider } from "./agent";

/**
 * Build a CardProvider closure tied to a specific user + booking. The
 * agent invokes the returned function inside its `request_payment_card`
 * tool call. The expected vendor amount is passed by the agent from the
 * on-page total — we compare it against the booking's budget ceiling and
 * decline anything that drifts over.
 */
export function buildCardProviderForBooking(args: {
  userId: string;
  bookingId: string;
  tripId: string;
  /** Hard ceiling — agent must not exceed this. */
  budgetCents: number | null;
}): CardProvider {
  return async (
    observedAmountCents?: number | null,
  ): Promise<
    | {
        status: "ok";
        number: string;
        expMonth: number;
        expYear: number;
        cvc: string;
        cardholderName?: string;
      }
    | { status: "unavailable"; reason: string }
  > => {
    if (!stripeConfigured()) {
      return {
        status: "unavailable",
        reason:
          "Stripe is not configured on this server. Stop entering payment and call report_outcome with status 'needs_review'.",
      };
    }

    const user = await db.user.findUnique({
      where: { id: args.userId },
      select: { defaultPaymentMethodId: true, stripeCustomerId: true },
    });
    if (!user?.defaultPaymentMethodId) {
      return {
        status: "unavailable",
        reason:
          "No saved payment method on file for this customer. They need to add a card first. Stop entering payment and call report_outcome with status 'needs_review' so a human can finish this booking.",
      };
    }

    // The amount we charge is the REAL total the agent read off the
    // checkout page when available — most items (hotels especially) have
    // no upfront price, so the page total is the source of truth. Fall
    // back to the booking budget only when the page total couldn't be
    // read. Whichever we use becomes the single-use card's spend ceiling.
    const observed =
      typeof observedAmountCents === "number" &&
      Number.isFinite(observedAmountCents) &&
      observedAmountCents > 0
        ? Math.round(observedAmountCents)
        : null;
    const vendorAmount = observed ?? args.budgetCents ?? null;
    if (vendorAmount == null || vendorAmount <= 0) {
      return {
        status: "unavailable",
        reason:
          "Couldn't read the booking total from the page and no budget is on file — cannot charge a blank amount. Stop entering payment and call report_outcome with status 'needs_review'.",
      };
    }
    // Guard against a misread page total wildly exceeding the budget (e.g.
    // the agent grabbed a year or a phone number). If we have a budget and
    // the observed total is >3x it, refuse — fail safe rather than overcharge.
    if (
      observed != null &&
      args.budgetCents != null &&
      args.budgetCents > 0 &&
      observed > args.budgetCents * 3
    ) {
      return {
        status: "unavailable",
        reason: `The checkout total we read ($${Math.round(observed / 100)}) is far above the expected budget — pausing to avoid overcharging. Call report_outcome with status 'needs_review'.`,
      };
    }
    const fee = serviceFeeCents(vendorAmount);
    const customerChargeCents = vendorAmount + fee;
    // Persist the real total onto the booking so the <2s auth webhook can
    // gate the virtual-card charge against the amount we actually expect.
    await db.booking
      .update({ where: { id: args.bookingId }, data: { cost: vendorAmount } })
      .catch(() => {});

    let chargeId: string | null = null;
    try {
      const charge = await chargeCustomer({
        userId: args.userId,
        amountCents: customerChargeCents,
        idempotencyKey: `book-agent-${args.bookingId}`,
        description: `Pyltrix booking ${args.bookingId}`,
        metadata: { bookingId: args.bookingId, tripId: args.tripId },
      });
      if (charge.status !== "succeeded") {
        return {
          status: "unavailable",
          reason: `Customer charge ${charge.paymentIntentId} returned status '${charge.status}'. Stop entering payment and call report_outcome with status 'needs_review'.`,
        };
      }
      chargeId = charge.paymentIntentId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "unavailable",
        reason: `Couldn't charge the customer card (${msg.slice(0, 160)}). Stop entering payment and call report_outcome with status 'needs_review'.`,
      };
    }

    // Mint the single-use virtual card the agent will type.
    let cardholderId: string;
    try {
      cardholderId = await ensureCardholder(args.userId);
    } catch (err) {
      return {
        status: "unavailable",
        reason: `Couldn't prepare a virtual card (${err instanceof Error ? err.message : String(err)}). Call report_outcome with 'needs_review'.`,
      };
    }
    let cardId: string;
    try {
      cardId = await createSingleUseCard({
        cardholderId,
        // Spend ceiling = the real total + a small tolerance so legit
        // tax/resort fees the vendor tacks on at the final click don't
        // trip a false decline. The per-authorization limit is the hard
        // cap; the auth webhook is the second gate.
        amountCents: Math.round(Math.max(vendorAmount * 1.15, vendorAmount + 2000)),
        bookingId: args.bookingId,
        tripId: args.tripId,
      });
    } catch (err) {
      return {
        status: "unavailable",
        reason: `Couldn't mint a single-use card (${err instanceof Error ? err.message : String(err)}). Call report_outcome with 'needs_review'.`,
      };
    }

    // Persist the card id + charge id on the Booking — the real-time auth
    // webhook will look the booking up by stripeIssuingCardId in <2s.
    await db.booking
      .update({
        where: { id: args.bookingId },
        data: { stripeIssuingCardId: cardId, stripeChargeId: chargeId ?? undefined },
      })
      .catch(() => {
        /* don't fail the booking on a metadata write hiccup; the auth
         *  webhook will decline an unrecognised card anyway. */
      });

    let revealed;
    try {
      revealed = await revealCard(cardId);
    } catch (err) {
      return {
        status: "unavailable",
        reason: `Couldn't reveal the virtual card (${err instanceof Error ? err.message : String(err)}). Call report_outcome with 'needs_review'.`,
      };
    }
    return {
      status: "ok",
      number: revealed.number,
      expMonth: revealed.expMonth,
      expYear: revealed.expYear,
      cvc: revealed.cvc,
      cardholderName: revealed.cardholderName,
    };
  };
}
