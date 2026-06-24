/**
 * Read the customer's saved card for display ("Visa •••• 4242, exp 4/27").
 *
 * We never store card details ourselves — Stripe holds them. This retrieves
 * the brand / last4 / expiry off the saved PaymentMethod so the billing
 * settings page can show which card the agent will use, and let the customer
 * replace or remove it. Safe to call when Stripe is unset or no card is saved
 * (returns null).
 */

import { stripe, stripeConfigured } from "@/lib/stripe";
import { db } from "@/lib/db";

export type SavedCard = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export async function getSavedCard(userId: string): Promise<SavedCard | null> {
  if (!stripeConfigured()) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { defaultPaymentMethodId: true },
  });
  if (!user?.defaultPaymentMethodId) return null;
  try {
    const pm = await stripe().paymentMethods.retrieve(
      user.defaultPaymentMethodId,
    );
    if (!pm.card) return null;
    return {
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    };
  } catch (err) {
    // A deleted/expired PM id on file shouldn't crash the settings page.
    console.warn("[saved-card] retrieve failed:", err);
    return null;
  }
}
