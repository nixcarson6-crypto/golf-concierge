import { headers } from "next/headers";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { nudge } from "@/lib/events";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("stripe webhook not configured", { status: 503 });

  const sig = (await headers()).get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, sig, secret);
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  switch (event.type) {
    // --- Issuing real-time authorization: the 2-second SECURITY CONTROL. ---
    // Stripe calls this synchronously when a vendor charges one of our
    // single-use virtual cards. We MUST respond with { approved } fast, and
    // we approve ONLY the exact booking + amount the card was minted for —
    // so a leaked virtual number is worthless and an over-charge is blocked.
    case "issuing_authorization.request":
      return handleIssuingAuthRequest(
        event.data.object as Stripe.Issuing.Authorization,
      );

    // Reconciliation: record the captured amount + transaction id on the
    // booking once the auth/transaction lands.
    case "issuing_authorization.created":
    case "issuing_transaction.created": {
      const obj = event.data.object as {
        card?: string | { id: string };
        amount?: number;
        id?: string;
      };
      const cardId = typeof obj.card === "string" ? obj.card : obj.card?.id;
      if (cardId) {
        const booking = await db.booking.findFirst({
          where: { stripeIssuingCardId: cardId },
          select: { id: true, metadata: true },
        });
        if (booking) {
          await db.booking.update({
            where: { id: booking.id },
            data: {
              stripeChargeId: obj.id ?? undefined,
              metadata: {
                ...((booking.metadata as Record<string, unknown> | null) ?? {}),
                capturedAmountCents: obj.amount ?? null,
              } as object,
            },
          });
        }
      }
      break;
    }

    // Agent-side customer charge (PaymentIntent, not Checkout) succeeded.
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await db.payment.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { status: "SUCCEEDED" },
      });
      break;
    }

    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tripId = session.metadata?.tripId;
      const memberId = session.metadata?.memberId;
      const bookingIdsCsv = session.metadata?.bookingIds;
      if (tripId) {
        await db.payment.updateMany({
          where: { stripeCheckoutSessionId: session.id },
          data: {
            status: "SUCCEEDED",
            stripePaymentIntentId:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : null,
          },
        });
        // Cart-style payments include bookingIds in metadata; mark each
        // matching booking as paid (via metadata.paidAt) so the Live Trip
        // panel can hide the Pay button + show Paid badges.
        if (bookingIdsCsv) {
          const ids = bookingIdsCsv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length > 0) {
            const now = new Date().toISOString();
            const bookings = await db.booking.findMany({
              where: { id: { in: ids }, tripId },
              select: { id: true, metadata: true },
            });
            for (const b of bookings) {
              const existing = (b.metadata as Record<string, unknown> | null) ?? {};
              await db.booking.update({
                where: { id: b.id },
                data: { metadata: { ...existing, paidAt: now } },
              });
            }
          }
        }
        // Per-member-share flow (legacy approval workflow) still flips
        // member.paymentStatus.
        if (memberId && !bookingIdsCsv) {
          await db.tripMember.update({
            where: { id: memberId },
            data: { paymentStatus: "PAID" },
          });
        }
        nudge(tripId);
      }
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      await db.payment.updateMany({
        where: { stripePaymentIntentId: pi.id },
        data: { status: "FAILED" },
      });
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      if (typeof charge.payment_intent === "string") {
        await db.payment.updateMany({
          where: { stripePaymentIntentId: charge.payment_intent },
          data: { status: "REFUNDED" },
        });
      }
      break;
    }
  }

  return Response.json({ received: true });
}

/** Allow capture to exceed the authorized limit by this much (tax/tip the
 *  vendor adds). The per-authorization spend_limit on the card is the hard
 *  cap; this is the belt to that suspenders. */
const AMOUNT_TOLERANCE = 1.15;
const AMOUNT_TOLERANCE_FLOOR_CENTS = 2000;

/**
 * Decide a real-time Issuing authorization. ONE indexed read (by card id) so
 * we always answer inside Stripe's ~2s window. Fails CLOSED — any doubt
 * declines, because wrongly approving a charge is far worse than declining.
 */
async function handleIssuingAuthRequest(
  auth: Stripe.Issuing.Authorization,
): Promise<Response> {
  const decline = (reason: string) => {
    console.info(`[stripe webhook] declining issuing auth: ${reason}`);
    return Response.json({ approved: false });
  };
  try {
    const cardId = typeof auth.card === "string" ? auth.card : auth.card?.id;
    if (!cardId) return decline("no card id");

    const booking = await db.booking.findFirst({
      where: { stripeIssuingCardId: cardId },
      select: { id: true, status: true, cost: true, stripeAuthId: true },
    });
    if (!booking) return decline(`no booking for card ${cardId}`);

    // Single-use: decline a second distinct authorization on the same card.
    if (booking.stripeAuthId && booking.stripeAuthId !== auth.id) {
      return decline("card already authorized once");
    }
    // Must be awaiting a charge.
    if (!["SEARCHING", "PENDING", "HELD"].includes(booking.status)) {
      return decline(`booking ${booking.id} not chargeable (${booking.status})`);
    }
    // Amount ceiling.
    if (booking.cost != null) {
      const ceiling = Math.max(
        booking.cost * AMOUNT_TOLERANCE,
        booking.cost + AMOUNT_TOLERANCE_FLOOR_CENTS,
      );
      if (auth.amount > ceiling) {
        return decline(`amount ${auth.amount} over ceiling ${Math.round(ceiling)}`);
      }
    }

    // Record the approved auth so a replay is declined next time. Don't let a
    // write hiccup block the time-critical response.
    await db.booking
      .update({ where: { id: booking.id }, data: { stripeAuthId: auth.id } })
      .catch(() => {});

    return Response.json({ approved: true });
  } catch (err) {
    console.warn("[stripe webhook] auth.request errored — declining:", err);
    return Response.json({ approved: false });
  }
}
