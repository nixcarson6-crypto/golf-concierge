import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { env } from "@/lib/env";
import { serviceFeeCents } from "@/lib/payments/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Aggregates every CONFIRMED booking on the trip that doesn't already have
 * a successful Payment, then creates one Stripe Checkout session covering
 * the lot. The webhook flips the matching Payment row to SUCCEEDED on
 * checkout.session.completed.
 *
 * UX: the user has the AI book everything they want, then taps "Pay $X"
 * in the Live Trip panel, which posts here and redirects to the Stripe URL.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const user = await requireUser();
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!stripeConfigured()) {
    return NextResponse.json(
      { error: "stripe not configured" },
      { status: 503 },
    );
  }

  const member = await db.tripMember.findFirst({
    where: { tripId, userId: user.id },
  });
  if (!member) {
    return NextResponse.json({ error: "not a member" }, { status: 403 });
  }

  // Pull every CONFIRMED booking and its itinerary item (need the title + cost
  // for line items).
  const bookings = await db.booking.findMany({
    where: { tripId, status: "CONFIRMED" },
    include: { itineraryItem: true },
    orderBy: { createdAt: "asc" },
  });

  // Already-paid bookings have a Payment with status SUCCEEDED referencing
  // them in metadata.bookingIds.
  const priorSucceeded = await db.payment.findMany({
    where: { tripId, status: "SUCCEEDED" },
    select: { metadata: true },
  });
  const paidBookingIds = new Set<string>();
  for (const p of priorSucceeded) {
    const meta = p.metadata as { bookingIds?: string[] } | null;
    if (Array.isArray(meta?.bookingIds)) {
      for (const id of meta.bookingIds) paidBookingIds.add(id);
    }
  }

  // Charge the card for PAY-NOW bookings ONLY. Hotels, golf, and dining settle
  // at the property (paymentMode "pay_at_property" — or, defensively, anything
  // not explicitly "pay_now") and must NEVER hit the card here — the customer
  // pays those at the venue. We also skip anything already charged at booking
  // time (a Stripe charge id, a metadata.paidAt stamp, or a prior succeeded
  // Payment) so a flight/API-hotel that was paid when it booked can't be
  // double-charged. Defaulting the absent case to "skip" is deliberate: never
  // run the customer's card unless we're certain the item is pay-now-unpaid.
  const unpaid = bookings.filter((b) => {
    if (paidBookingIds.has(b.id)) return false;
    if ((b.cost ?? 0) <= 0) return false;
    if (b.stripeChargeId) return false; // already charged the customer directly
    const meta = (b.metadata as { paymentMode?: string; paidAt?: string } | null) ?? {};
    if (meta.paidAt) return false; // already paid at booking time
    return meta.paymentMode === "pay_now";
  });
  if (unpaid.length === 0) {
    return NextResponse.json(
      { error: "Nothing to pay now — every booking is already paid or settles at the property." },
      { status: 400 },
    );
  }

  const currency = trip.currency.toLowerCase();
  const itemLines = unpaid.map((b) => ({
    price_data: {
      currency,
      product_data: {
        name: b.itineraryItem?.title ?? `${b.type} booking`,
        description: b.confirmationCode
          ? `Confirmation ${b.confirmationCode}`
          : undefined,
      },
      unit_amount: b.cost ?? 0,
    },
    quantity: 1,
  }));

  const subtotal = unpaid.reduce((sum, b) => sum + (b.cost ?? 0), 0);
  // Pyltrix concierge service fee — a separate, transparent line item so the
  // customer sees exactly what they're paying for. Rate lives in
  // payments/pricing (ONE source of truth, shared with the agent-path charge).
  const fee = serviceFeeCents(subtotal);
  const lineItems = [
    ...itemLines,
    ...(fee > 0
      ? [
          {
            price_data: {
              currency,
              product_data: {
                name: "Pyltrix concierge service",
                description: undefined as string | undefined,
              },
              unit_amount: fee,
            },
            quantity: 1,
          },
        ]
      : []),
  ];

  const total = subtotal + fee;

  const sk = stripe();
  const appUrl = env("NEXT_PUBLIC_APP_URL");
  const session = await sk.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: lineItems,
    success_url: `${appUrl}/trips/${tripId}?paid=1`,
    cancel_url: `${appUrl}/trips/${tripId}?paid=0`,
    metadata: {
      tripId,
      memberId: member.id,
      bookingIds: unpaid.map((b) => b.id).join(","),
    },
  });

  if (!session.id || !session.url) {
    return NextResponse.json(
      { error: "stripe session creation failed" },
      { status: 502 },
    );
  }

  await db.payment.create({
    data: {
      tripId,
      memberId: member.id,
      stripeCheckoutSessionId: session.id,
      amount: total,
      currency: trip.currency,
      status: "PENDING",
      paymentType: "FULL",
      metadata: {
        kind: "cart",
        bookingIds: unpaid.map((b) => b.id),
      },
    },
  });

  return NextResponse.json({ url: session.url, total, bookingCount: unpaid.length });
}
