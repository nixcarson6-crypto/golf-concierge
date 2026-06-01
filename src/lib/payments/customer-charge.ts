/**
 * The customer side of the money flow: Customer card → Pyltrix balance.
 *
 * - ensureCustomer: lazily create + cache a Stripe Customer per user.
 * - createSetupIntent: for the "save your card once" UI (Stripe.js collects
 *   the card; we never touch the raw number).
 * - chargeCustomer: charge the saved card for (vendor cost + service fee)
 *   off-session. This is where Pyltrix earns its margin and funds the
 *   single-use virtual card that pays the vendor.
 *
 * Account-gated on STRIPE_SECRET_KEY.
 */

import Stripe from "stripe";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { db } from "@/lib/db";

/** Get (or create) the Stripe Customer for a user, caching the id. */
export async function ensureCustomer(userId: string): Promise<string> {
  if (!stripeConfigured()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing).");
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, email: true, name: true },
  });
  if (!user) throw new Error(`User ${userId} not found.`);
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe().customers.create({
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    metadata: { appUserId: userId },
  });
  await db.user.update({
    where: { id: userId },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

/**
 * Create a SetupIntent so the customer can save a card via Stripe.js. The
 * client confirms it with the publishable key; on success Stripe attaches
 * the PaymentMethod to the customer and we record it as their default.
 */
export async function createSetupIntent(userId: string): Promise<{
  clientSecret: string;
  customerId: string;
}> {
  const customerId = await ensureCustomer(userId);
  const intent = await stripe().setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { appUserId: userId },
  });
  if (!intent.client_secret) {
    throw new Error("Stripe did not return a SetupIntent client secret.");
  }
  return { clientSecret: intent.client_secret, customerId };
}

/** Record the saved card as the user's default after a SetupIntent succeeds. */
export async function setDefaultPaymentMethod(
  userId: string,
  paymentMethodId: string,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { defaultPaymentMethodId: paymentMethodId },
  });
}

export type ChargeResult = {
  paymentIntentId: string;
  status: Stripe.PaymentIntent.Status;
  amountCents: number;
};

/**
 * Charge the customer's saved card for (vendor cost + service fee),
 * off-session. This funds the booking; the single-use virtual card then
 * pays the vendor. Pass a stable `idempotencyKey` (e.g. the bookingId) so
 * an Inngest retry can never double-charge.
 *
 * `paymentMethodId` defaults to the user's saved default. In test mode you
 * can pass a test PaymentMethod (e.g. "pm_card_visa") to exercise the path
 * without the save-card UI.
 */
export async function chargeCustomer(args: {
  userId: string;
  amountCents: number;
  idempotencyKey: string;
  paymentMethodId?: string;
  description?: string;
  metadata?: Record<string, string>;
}): Promise<ChargeResult> {
  if (!stripeConfigured()) {
    throw new Error("Stripe is not configured.");
  }
  if (!Number.isFinite(args.amountCents) || args.amountCents <= 0) {
    throw new Error(`Invalid charge amount: ${args.amountCents}`);
  }
  const customerId = await ensureCustomer(args.userId);
  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { defaultPaymentMethodId: true },
  });
  const paymentMethod = args.paymentMethodId ?? user?.defaultPaymentMethodId;
  if (!paymentMethod) {
    throw new Error(
      "No saved payment method for this user — they need to add a card first.",
    );
  }

  const intent = await stripe().paymentIntents.create(
    {
      amount: Math.round(args.amountCents),
      currency: "usd",
      customer: customerId,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      description: args.description ?? "Pyltrix booking",
      metadata: { appUserId: args.userId, ...(args.metadata ?? {}) },
    },
    { idempotencyKey: args.idempotencyKey },
  );

  return {
    paymentIntentId: intent.id,
    status: intent.status,
    amountCents: intent.amount,
  };
}
