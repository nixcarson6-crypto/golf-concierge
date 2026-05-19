import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "stripe not configured" }, { status: 503 });
  }

  const [members, itinerary] = await Promise.all([
    db.tripMember.findMany({ where: { tripId } }),
    db.itinerary.findFirst({
      where: { tripId, status: { in: ["CURRENT", "APPROVED"] } },
      orderBy: { version: "desc" },
    }),
  ]);
  if (!itinerary?.perPersonCost) {
    return NextResponse.json(
      { error: "no per-person cost on itinerary" },
      { status: 400 },
    );
  }

  const sk = stripe();
  const appUrl = env("NEXT_PUBLIC_APP_URL");
  const results: Array<{ memberId: string; url: string }> = [];

  for (const m of members) {
    // One Stripe Checkout Session per member — works with deferred payment.
    const session = await sk.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: trip.currency.toLowerCase(),
            product_data: { name: `${trip.title} — ${m.name ?? m.email}` },
            unit_amount: itinerary.perPersonCost,
          },
          quantity: 1,
        },
      ],
      customer_email: m.email,
      metadata: { tripId, memberId: m.id, itineraryId: itinerary.id },
      success_url: `${appUrl}/checkout/success?trip=${tripId}`,
      cancel_url: `${appUrl}/checkout/cancel?trip=${tripId}`,
    });

    await db.payment.create({
      data: {
        tripId,
        memberId: m.id,
        amount: itinerary.perPersonCost,
        currency: trip.currency,
        status: "PENDING",
        paymentType: "FULL",
        stripeCheckoutSessionId: session.id,
        metadata: { url: session.url },
      },
    });

    if (session.url) results.push({ memberId: m.id, url: session.url });
  }

  return NextResponse.json({ ok: true, links: results });
}
