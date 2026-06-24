/**
 * "Save your card" — creates a Stripe Checkout Session in SETUP mode and
 * returns its hosted URL. The customer enters their card on Stripe's own
 * page (we never touch the raw number — PCI stays with Stripe), and on
 * success Stripe fires `checkout.session.completed` which the webhook turns
 * into the user's default payment method.
 *
 * Using hosted Checkout (vs. Stripe.js Elements) means ZERO frontend Stripe
 * dependencies — the client just redirects to the returned URL.
 *
 * Gated on STRIPE_SECRET_KEY; returns 503 when Stripe isn't configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { ensureCustomer } from "@/lib/payments/customer-charge";
import { optionalEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: "Payments aren't enabled yet (Stripe not configured)." },
      { status: 503 },
    );
  }
  const user = await requireUser();

  const body = (await req.json().catch(() => ({}))) as { returnTo?: string };
  const appUrl =
    optionalEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000";
  // Only allow same-origin relative return paths, to avoid an open redirect.
  const returnPath =
    typeof body.returnTo === "string" && body.returnTo.startsWith("/")
      ? body.returnTo
      : "/dashboard";

  // Wrap the live Stripe calls — a bad/expired key, rate-limit, or network blip
  // would otherwise throw an unhandled 500 on the launch-critical Save-card flow.
  try {
    const customerId = await ensureCustomer(user.id);
    const session = await stripe().checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      // Pass the session id back so the trip page can CONFIRM the saved card
      // synchronously on return — the webhook (which normally records it) can't
      // reach localhost, and even in prod a synchronous confirm is instant +
      // more reliable. {CHECKOUT_SESSION_ID} is a literal Stripe template token.
      success_url: `${appUrl}${returnPath}${returnPath.includes("?") ? "&" : "?"}card_saved={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}${returnPath}`,
      metadata: { appUserId: user.id },
    });
    if (!session.url) {
      return NextResponse.json(
        { error: "Couldn't start secure card setup — please try again." },
        { status: 502 },
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[payment-method/checkout] Stripe error:", err);
    return NextResponse.json(
      { error: "Couldn't start secure card setup — please try again in a moment." },
      { status: 502 },
    );
  }
}
