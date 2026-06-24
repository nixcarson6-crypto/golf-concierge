/**
 * The customer's saved card — read + remove.
 *
 *   GET    → the card on file (brand / last4 / expiry) for the billing page.
 *   DELETE → remove it: detach from Stripe AND clear the default so the agent
 *            stops using it. The customer can add a fresh one via the Checkout
 *            setup flow (../payment-method/checkout).
 *
 * Replacing a card doesn't go through here — that's "add a new card" via
 * Checkout, which sets it as the new default (and detaches the old one in the
 * confirm step).
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { db } from "@/lib/db";
import { getSavedCard } from "@/lib/payments/saved-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  const card = await getSavedCard(user.id);
  return NextResponse.json({ card, stripeEnabled: stripeConfigured() });
}

export async function DELETE() {
  const user = await requireUser();
  const me = await db.user.findUnique({
    where: { id: user.id },
    select: { defaultPaymentMethodId: true },
  });
  const pmId = me?.defaultPaymentMethodId ?? null;

  // Clear our pointer first so the agent can't pick it up mid-removal, then
  // best-effort detach from Stripe (a detach failure shouldn't leave the card
  // "stuck" on file in our UI).
  await db.user.update({
    where: { id: user.id },
    data: { defaultPaymentMethodId: null },
  });
  if (pmId && stripeConfigured()) {
    try {
      await stripe().paymentMethods.detach(pmId);
    } catch (err) {
      console.warn("[payment-method] detach failed (cleared default anyway):", err);
    }
  }
  return NextResponse.json({ ok: true });
}
