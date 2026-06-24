/**
 * Confirm a saved card SYNCHRONOUSLY on return from Stripe Checkout.
 *
 * The "save your card" flow (../checkout) sends the customer to Stripe's
 * hosted setup page, then back to the trip with `?card_saved=<sessionId>`.
 * Normally `checkout.session.completed` (the webhook) records the card — but
 * a webhook CANNOT reach localhost, so in dev the card silently never saves.
 * This endpoint closes that gap: the client posts the returned sessionId, we
 * read the Checkout Session straight from Stripe and record the card right
 * then. It mirrors the webhook's setup-mode handler exactly and is idempotent
 * with it (both just set `defaultPaymentMethodId`), so in prod whichever wins
 * the race is fine.
 *
 * Gated on STRIPE_SECRET_KEY; verifies the session belongs to THIS user so a
 * guessed/stale id can't attach someone else's card.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { setDefaultPaymentMethod } from "@/lib/payments/customer-charge";

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

  const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return NextResponse.json({ error: "Missing session id." }, { status: 400 });
  }

  try {
    const session = await stripe().checkout.sessions.retrieve(sessionId);

    // This must be a setup-mode session that THIS user started — never attach a
    // card from someone else's (or a non-setup) session.
    if (session.mode !== "setup") {
      return NextResponse.json({ error: "Not a card-setup session." }, { status: 400 });
    }
    if (session.metadata?.appUserId !== user.id) {
      return NextResponse.json({ error: "Session does not belong to you." }, { status: 403 });
    }

    const setupIntentId =
      typeof session.setup_intent === "string"
        ? session.setup_intent
        : session.setup_intent?.id;
    if (!setupIntentId) {
      // Stripe hasn't finished provisioning the SetupIntent yet — the webhook
      // will still catch it. Report "not saved yet" without erroring.
      return NextResponse.json({ ok: true, saved: false });
    }

    const si = await stripe().setupIntents.retrieve(setupIntentId);
    const pm =
      typeof si.payment_method === "string"
        ? si.payment_method
        : si.payment_method?.id;
    if (!pm) {
      return NextResponse.json({ ok: true, saved: false });
    }

    await setDefaultPaymentMethod(user.id, pm);
    return NextResponse.json({ ok: true, saved: true });
  } catch (err) {
    console.error("[payment-method/confirm] Stripe error:", err);
    return NextResponse.json(
      { error: "Couldn't confirm your saved card — please try again." },
      { status: 502 },
    );
  }
}
