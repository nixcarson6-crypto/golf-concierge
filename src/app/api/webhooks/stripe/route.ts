import { headers } from "next/headers";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";

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
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tripId = session.metadata?.tripId;
      const memberId = session.metadata?.memberId;
      if (tripId && memberId) {
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
        await db.tripMember.update({
          where: { id: memberId },
          data: { paymentStatus: "PAID" },
        });
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
