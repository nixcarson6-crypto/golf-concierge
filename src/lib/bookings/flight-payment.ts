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
  | { mode: "booked"; result: Extract<BookFlightResult, { ok: true }> }
  | {
      mode: "self_book";
      reason:
        | "autobook_disabled"
        | "stripe_not_configured"
        | "no_saved_card"
        | "no_price"
        | "charge_failed";
    }
  | { mode: "failed"; error: string };

/**
 * Book a flight on behalf of a customer WITHOUT ever fronting the cost.
 *
 * Returns:
 *  - { mode: "self_book" } — we did not (and will not) spend our balance; the
 *    caller should surface a self-book link. This is the default outcome.
 *  - { mode: "booked", result } — charged the customer, then ticketed.
 *  - { mode: "failed", error } — a post-charge booking failure (already
 *    refunded) or a hard error.
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
  // 1) Default + master switch: self-book. Never touch our balance.
  if (!flightAutoBookEnabled()) {
    return { mode: "self_book", reason: "autobook_disabled" };
  }

  // 2) Auto-book requires the customer's money in hand first → Stripe + a
  //    saved card. Missing either ⇒ fall back to self-book (never balance).
  if (!stripeConfigured()) {
    return { mode: "self_book", reason: "stripe_not_configured" };
  }
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { defaultPaymentMethodId: true },
  });
  if (!user?.defaultPaymentMethodId) {
    return { mode: "self_book", reason: "no_saved_card" };
  }

  // 3) Determine what to charge. Prefer the caller's price; otherwise fetch the
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

  // 4) Charge the CUSTOMER (ticket + service fee) before we spend a cent.
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
        `[flight-payment] customer charge status '${charge.status}' — self-book`,
      );
      return { mode: "self_book", reason: "charge_failed" };
    }
    chargeId = charge.paymentIntentId;
  } catch (err) {
    console.warn("[flight-payment] customer charge failed — self-book:", err);
    return { mode: "self_book", reason: "charge_failed" };
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
  return { mode: "booked", result };
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
