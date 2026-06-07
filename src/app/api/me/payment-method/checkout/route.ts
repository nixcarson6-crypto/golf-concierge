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

  const customerId = await ensureCustomer(user.id);
  const session = await stripe().checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: `${appUrl}${returnPath}${returnPath.includes("?") ? "&" : "?"}card_saved=1`,
    cancel_url: `${appUrl}${returnPath}`,
    metadata: { appUserId: user.id },
  });

  if (!session.url) {
    return NextResponse.json(
      { error: "Stripe didn't return a checkout URL." },
      { status: 502 },
    );
  }
  return NextResponse.json({ url: session.url });
}
