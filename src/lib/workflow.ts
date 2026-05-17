/**
 * The auto-workflow chain.
 *
 * The product principle: the user clicks ONE button ("Approve & book") and
 * the rest happens autonomously. This module is the orchestration that
 * makes that true:
 *
 *   approveItinerary()
 *     ├── flip itinerary → APPROVED, trip → BOOKING
 *     ├── notify the group
 *     ├── kick off the booking executor in parallel
 *     │     └── fallback agent on per-item failure
 *     ├── auto-create per-member Stripe checkout sessions
 *     │     └── email each member their pay link via Resend
 *     └── when every booking lands → auto-generate the trip summary
 *         and notify the group again.
 *
 * Anything that needs payment-on-book or partner-API auth happens here; the
 * UI just shows live status. No manual button-clicking required.
 */

import { db } from "@/lib/db";
import { executeItineraryBookings } from "./bookings/executor";
import { runSummaryAgent } from "./ai/agents/summary";
import { nudge } from "./events";
import { stripe, stripeConfigured } from "./stripe";
import { env } from "./env";
import { renderInviteEmail, sendEmail } from "./email";

export async function approveItinerary(args: {
  tripId: string;
  itineraryId: string;
  userId: string;
}) {
  const { tripId, itineraryId } = args;

  await db.$transaction([
    db.itinerary.update({
      where: { id: itineraryId },
      data: { status: "APPROVED" },
    }),
    db.trip.update({
      where: { id: tripId },
      data: { status: "BOOKING" },
    }),
  ]);

  await broadcastNotification({
    tripId,
    type: "APPROVAL_GIVEN",
    title: "Itinerary approved",
    message: "Bookings are running now — sit tight, no action needed.",
  });
  nudge(tripId);

  // Run all three side-effects in parallel — none blocks the others.
  void Promise.allSettled([
    runBookingsThenSummary(tripId, itineraryId).catch((err) =>
      console.error("[workflow] bookings", err),
    ),
    createGroupPaymentLinks(tripId, itineraryId).catch((err) =>
      console.error("[workflow] payment links", err),
    ),
  ]);
}

async function runBookingsThenSummary(tripId: string, itineraryId: string) {
  await executeItineraryBookings(itineraryId);

  // Wait briefly for any fallback regenerations triggered by failed bookings
  // to settle before generating the final summary.
  await new Promise((r) => setTimeout(r, 1500));

  const finalIt = await db.itinerary.findFirst({
    where: { tripId, status: "APPROVED" },
    orderBy: { version: "desc" },
    include: { items: { include: { booking: true }, orderBy: { orderIndex: "asc" } } },
  });
  const trip = await db.trip.findUnique({ where: { id: tripId } });
  if (!finalIt || !trip) return;

  const allBooked = finalIt.items.every(
    (i) =>
      i.confirmationState === "CONFIRMED" ||
      i.confirmationState === "HOLDING" ||
      i.type === "FREE_TIME",
  );
  if (allBooked) {
    await db.trip.update({ where: { id: tripId }, data: { status: "BOOKED" } });
  }

  // Generate the summary either way — substitutions made during fallback are
  // part of what makes the summary useful.
  try {
    const summary = await runSummaryAgent({
      tripId,
      context: {
        title: trip.title,
        destination: trip.destination,
        startDate: trip.startDate?.toISOString() ?? null,
        endDate: trip.endDate?.toISOString() ?? null,
        groupSize: trip.groupSize,
        totalCost: finalIt.totalCost,
        perPersonCost: finalIt.perPersonCost,
        items: finalIt.items.map((i) => ({
          type: i.type,
          title: i.title,
          startTime: i.startTime?.toISOString() ?? null,
          cost: i.cost,
          status: i.status ?? null,
          confirmationCode: i.booking?.confirmationCode ?? null,
        })),
        substitutions:
          ((finalIt.diff as { changes?: string[] } | null)?.changes) ?? [],
      },
    });

    await db.tripSummary.upsert({
      where: { tripId },
      create: {
        tripId,
        itineraryId: finalIt.id,
        content: summary.content,
        highlights: {
          items: summary.highlights,
          substitutions: summary.substitutions,
        },
        totalCost: finalIt.totalCost,
        perPersonCost: finalIt.perPersonCost,
        shareToken: shareToken(),
      },
      update: {
        itineraryId: finalIt.id,
        content: summary.content,
        highlights: {
          items: summary.highlights,
          substitutions: summary.substitutions,
        },
        totalCost: finalIt.totalCost,
        perPersonCost: finalIt.perPersonCost,
        generatedAt: new Date(),
      },
    });

    await broadcastNotification({
      tripId,
      type: allBooked ? "BOOKING_CONFIRMED" : "ITINERARY_REVISED",
      title: allBooked ? "Trip booked" : "Trip largely booked",
      message: allBooked
        ? "Every line is confirmed. Final summary is ready."
        : "Most items are confirmed. Anything that needed re-optimization is logged.",
    });
  } catch (err) {
    console.error("[workflow] summary", err);
  }

  nudge(tripId);
}

async function createGroupPaymentLinks(tripId: string, itineraryId: string) {
  if (!stripeConfigured()) return;

  const [trip, members, itinerary] = await Promise.all([
    db.trip.findUnique({ where: { id: tripId } }),
    db.tripMember.findMany({ where: { tripId } }),
    db.itinerary.findUnique({ where: { id: itineraryId } }),
  ]);
  if (!trip || !itinerary?.perPersonCost) return;

  const sk = stripe();
  const appUrl = env("NEXT_PUBLIC_APP_URL");

  for (const m of members) {
    // Don't re-create if a pending Payment already exists for this itinerary.
    const existing = await db.payment.findFirst({
      where: { tripId, memberId: m.id, status: { in: ["PENDING", "PROCESSING"] } },
    });
    if (existing) continue;

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

    if (session.url) {
      try {
        await sendEmail({
          to: m.email,
          subject: `Your share of ${trip.title}`,
          html: renderInviteEmail({
            ownerName: "Your concierge",
            tripTitle: `Time to settle up — ${trip.title}`,
            destination: trip.destination,
            inviteUrl: session.url,
          }).html.replace("View the trip", "Pay your share"),
        });
      } catch (err) {
        console.error("[workflow] pay-link email", err);
      }
    }

    await db.notification.create({
      data: {
        tripId,
        userId: m.userId ?? "system",
        type: "PAYMENT_REQUESTED",
        title: "Your trip share is ready",
        message: "Open the trip → payments to settle up.",
      },
    });
  }
  nudge(tripId);
}

async function broadcastNotification(args: {
  tripId: string;
  type:
    | "TRIP_UPDATED"
    | "ITINERARY_REVISED"
    | "APPROVAL_REQUESTED"
    | "APPROVAL_GIVEN"
    | "PAYMENT_REQUESTED"
    | "PAYMENT_RECEIVED"
    | "BOOKING_CONFIRMED"
    | "BOOKING_FAILED"
    | "INVITE_SENT"
    | "AGENT_COMPLETED"
    | "SYSTEM";
  title: string;
  message: string;
}) {
  const members = await db.tripMember.findMany({
    where: { tripId: args.tripId },
    select: { userId: true },
  });
  const ids = members.map((m) => m.userId).filter(Boolean) as string[];
  if (ids.length === 0) return;
  await db.notification.createMany({
    data: ids.map((userId) => ({
      tripId: args.tripId,
      userId,
      type: args.type,
      title: args.title,
      message: args.message,
    })),
  });
}

function shareToken() {
  // Compact, URL-safe, hard to enumerate.
  return Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 11);
}
