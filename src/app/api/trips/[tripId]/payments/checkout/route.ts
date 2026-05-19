import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { env } from "@/lib/env";
import { suggestedDepositCents } from "@/lib/bookings/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  paymentType: z.enum(["FULL", "DEPOSIT"]).default("FULL"),
});

/**
 * Creates a Stripe checkout session for the calling member. Either FULL share
 * of the per-person cost, or a 25%-of-total DEPOSIT split across the group.
 * Mirrors the workflow's auto-link generation but lets a single member
 * trigger it on demand if their link is missing.
 */
export async function POST(
  req: Request,
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

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return new NextResponse("invalid body", { status: 400 });

  const member = await db.tripMember.findFirst({
    where: { tripId, userId: user.id },
  });
  if (!member) {
    return NextResponse.json({ error: "not a member" }, { status: 403 });
  }

  const it = await db.itinerary.findFirst({
    where: { tripId, status: { in: ["CURRENT", "APPROVED"] } },
    orderBy: { version: "desc" },
  });
  if (!it?.perPersonCost) {
    return NextResponse.json(
      { error: "per-person cost not ready" },
      { status: 400 },
    );
  }

  const groupSize = Math.max(1, trip.groupSize ?? 1);
  const amount =
    body.data.paymentType === "DEPOSIT"
      ? Math.round(suggestedDepositCents({ itineraryTotalCents: it.totalCost ?? 0 }) / groupSize)
      : it.perPersonCost;

  const sk = stripe();
  const appUrl = env("NEXT_PUBLIC_APP_URL");
  const session = await sk.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: trip.currency.toLowerCase(),
          product_data: {
            name: `${trip.title} — ${
              body.data.paymentType === "DEPOSIT" ? "Deposit · " : ""
            }${member.name ?? member.email}`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      },
    ],
    customer_email: member.email,
    metadata: {
      tripId,
      memberId: member.id,
      itineraryId: it.id,
      paymentType: body.data.paymentType,
    },
    success_url: `${appUrl}/checkout/success?trip=${tripId}`,
    cancel_url: `${appUrl}/checkout/cancel?trip=${tripId}`,
  });

  await db.payment.create({
    data: {
      tripId,
      memberId: member.id,
      amount,
      currency: trip.currency,
      status: "PENDING",
      paymentType: body.data.paymentType,
      stripeCheckoutSessionId: session.id,
      metadata: { url: session.url },
    },
  });

  return NextResponse.json({ ok: true, url: session.url });
}
