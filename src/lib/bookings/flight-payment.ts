/**
 * The money guardrail for flights.
 *
 * A flight may ONLY be auto-booked through Duffel when the customer's money is
 * already in hand. Duffel's `type: "balance"` payment spends Pyltrix's OWN
 * Duffel balance — so booking a customer's flight that way means WE front the
 * cost. We never want that. This module is the single gate every flight
 * booking path goes through so that can't happen by accident.
 *
 * DEFAULT (FLIGHT_AUTOBOOK_ENABLED unset/false): flights are SELF-BOOK. We hand
 * the customer a direct booking link — their card pays the airline directly —
 * and never touch our balance. Zero capital required; same philosophy as
 * self-book golf. This is the launch posture.
 *
 * OPT-IN (FLIGHT_AUTOBOOK_ENABLED=true): we auto-book through Duffel, but only
 * after charging the CUSTOMER's saved card (ticket + service fee) via Stripe.
 * The balance spend is then backed by money we already collected. If the
 * booking fails after the charge, we refund the customer automatically.
 *
 * Float note (so nobody is surprised when they flip the flag on): the customer
 * charge lands in our STRIPE balance, while Duffel pulls from our DUFFEL
 * balance, which settles ~2 days later — so a small Duffel float bridges the
 * gap at volume. The fully float-free path is Duffel Payments (the customer's
 * card pays Duffel directly); that's a later upgrade. Until then, default-off
 * self-book is the truly-zero-from-our-card mode.
 */

import { db } from "@/lib/db";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { chargeCustomer } from "@/lib/payments/customer-charge";
import { serviceFeeCents } from "@/lib/payments/pricing";
import { optionalEnv } from "@/lib/env";
import {
  bookFlightOffer,
  type BookFlightPassenger,
  type BookFlightResult,
} from "./providers/duffel-book";

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

/**
 * Master switch. OFF (default) ⇒ flights self-book; we never spend our Duffel
 * balance. ON ⇒ auto-book through Duffel after charging the customer first.
 */
export function flightAutoBookEnabled(): boolean {
  return (
    (process.env.FLIGHT_AUTOBOOK_ENABLED ?? "").trim().toLowerCase() === "true"
  );
}

/**
 * True when DUFFEL_API_KEY is a sandbox/test key (`duffel_test_…`). In sandbox,
 * Duffel charges a TEST balance — booking costs no real money — so we auto-book
 * freely: the whole flow is testable end-to-end and the customer sees a real
 * (sandbox) confirmation. We only fall back to "test" matching; an unknown key
 * format is treated as LIVE (the safe default — gate it, don't risk real money).
 */
export function isDuffelSandbox(): boolean {
  return (optionalEnv("DUFFEL_API_KEY") ?? "").includes("test");
}

/**
 * A direct booking link for a flight the customer reserves themselves. Google
 * Flights resolves a plain "flights from X to Y on DATE" query to a real,
 * bookable search, so the customer lands one tap from buying — paying the
 * airline with their own card.
 */
export function flightSelfBookLink(args: {
  origin: string;
  destination: string;
  departDate?: string | null; // YYYY-MM-DD
  returnDate?: string | null; // YYYY-MM-DD
}): string {
  const parts = [`flights from ${args.origin} to ${args.destination}`];
  if (args.departDate) parts.push(`on ${args.departDate}`);
  if (args.returnDate) parts.push(`through ${args.returnDate}`);
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(
    parts.join(" "),
  )}`;
}

export type CustomerFlightOutcome =
  // `chargeId` is the Stripe PaymentIntent that paid for the ticket (set when
  // Stripe charged the customer; null in the no-Stripe sandbox path). The
  // caller MUST persist it on the booking so the ticket isn't charged a second
  // time by the cart, and so a later remove/cancel can refund it.
  | {
      mode: "booked";
      result: Extract<BookFlightResult, { ok: true }>;
      chargeId?: string | null;
    }
  // The customer has no saved card — the UI must send them to Stripe Checkout
  // (SaveCardButton) to add one, THEN book. We never front the cost.
  | { mode: "needs_card" }
  | { mode: "self_book"; reason: "stripe_not_configured" | "no_price" }
  | { mode: "failed"; error: string };

/**
 * Book a flight for a customer, routing the money through Stripe.
 *
 * THE MONEY FLOW. When Stripe is configured we ALWAYS charge the customer's
 * saved card (ticket + fee) FIRST, then book the vendor — in sandbox too (a
 * test charge), so the flow is verifiable end-to-end and we never front the
 * cost. Outcomes:
 *  - "booked"     — charged the customer, then ticketed.
 *  - "needs_card" — no saved card; the UI collects one via Stripe Checkout.
 *  - "self_book"  — no Stripe configured on a LIVE key (we won't front it), or
 *                   no price to charge.
 *  - "failed"     — a post-charge booking failure (already refunded) or error.
 *
 * Dev fallback (no Stripe keys at all): sandbox books on the free test balance
 * so local dev still works; live self-books.
 */
export async function bookFlightForCustomer(args: {
  userId: string;
  tripId: string;
  offerId: string;
  passengers: BookFlightPassenger[];
  /** Ticket total in cents (from the suggested offer). When omitted we fetch
   *  it from Duffel before charging. */
  ticketCents?: number | null;
}): Promise<CustomerFlightOutcome> {
  // ── No Stripe configured at all → dev fallback ──────────────────────────
  // Sandbox books free (so local dev without Stripe keys still works); a live
  // key with no Stripe means we can't charge anyone, so we never front it.
  if (!stripeConfigured()) {
    if (isDuffelSandbox()) {
      try {
        const result = await bookFlightOffer({
          offerId: args.offerId,
          passengers: args.passengers,
        });
        return result.ok
          ? { mode: "booked", result }
          : { mode: "failed", error: result.error };
      } catch (err) {
        return {
          mode: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { mode: "self_book", reason: "stripe_not_configured" };
  }

  // ── Stripe configured → ALWAYS charge the customer first ────────────────
  // 1) Need a saved card. None ⇒ needs_card (UI → Stripe Checkout to add one).
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { defaultPaymentMethodId: true },
  });
  if (!user?.defaultPaymentMethodId) {
    return { mode: "needs_card" };
  }

  // 2) Determine what to charge. Prefer the caller's price; otherwise fetch the
  //    live offer total. No price ⇒ self-book rather than guess.
  let ticketCents =
    typeof args.ticketCents === "number" && args.ticketCents > 0
      ? Math.round(args.ticketCents)
      : null;
  if (ticketCents == null) {
    ticketCents = await fetchOfferTotalCents(args.offerId);
  }
  if (ticketCents == null || ticketCents <= 0) {
    return { mode: "self_book", reason: "no_price" };
  }

  // 3) Charge the CUSTOMER (ticket + service fee) before we spend a cent.
  const fee = serviceFeeCents(ticketCents);
  let chargeId: string;
  try {
    const charge = await chargeCustomer({
      userId: args.userId,
      amountCents: ticketCents + fee,
      // Stable per offer so an Inngest/route retry can't double-charge.
      idempotencyKey: `flight-${args.tripId}-${args.offerId}`,
      description: "Pyltrix flight booking",
      metadata: { tripId: args.tripId, kind: "flight" },
    });
    if (charge.status !== "succeeded") {
      console.warn(
        `[flight-payment] customer charge status '${charge.status}'`,
      );
      return {
        mode: "failed",
        error: `Your card didn't complete the payment (${charge.status}). Try a different card.`,
      };
    }
    chargeId = charge.paymentIntentId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[flight-payment] customer charge failed:", msg);
    return {
      mode: "failed",
      error: `Couldn't charge your card (${msg.slice(0, 120)}).`,
    };
  }

  // 5) Money is in hand → book the ticket from our Duffel balance.
  let result: BookFlightResult;
  try {
    result = await bookFlightOffer({
      offerId: args.offerId,
      passengers: args.passengers,
    });
  } catch (err) {
    await refundQuietly(chargeId);
    return {
      mode: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    // Booking didn't happen — give the customer their money back.
    await refundQuietly(chargeId);
    return { mode: "failed", error: result.error };
  }
  return { mode: "booked", result, chargeId };
}

/** Fetch a Duffel offer's total in cents (for the pre-charge). Null on error. */
async function fetchOfferTotalCents(offerId: string): Promise<number | null> {
  const apiKey = optionalEnv("DUFFEL_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch(`${DUFFEL_BASE}/air/offers/${offerId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Duffel-Version": DUFFEL_VERSION,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { total_amount?: string } };
    const amt = json.data?.total_amount;
    if (!amt) return null;
    return Math.round(parseFloat(amt) * 100);
  } catch {
    return null;
  }
}

/** Refund a customer charge when a post-charge booking fails. Best-effort —
 *  a refund hiccup is logged loudly so it can be settled by hand. */
async function refundQuietly(paymentIntentId: string): Promise<void> {
  try {
    await stripe().refunds.create({ payment_intent: paymentIntentId });
  } catch (err) {
    console.error(
      "[flight-payment] REFUND FAILED — refund this PaymentIntent by hand:",
      paymentIntentId,
      err,
    );
  }
}
