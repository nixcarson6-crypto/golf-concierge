/**
 * "Approve & book" — the second half of the hybrid price-approval flow.
 *
 * When the agent reached a venue's checkout and found the REAL total above
 * the customer-reviewed estimate, it paused (booking → NEEDS_REVIEW with
 * metadata.failureReason = "price_approval" + quotedPriceCents) instead of
 * paying. This route records the customer's approval of that real price and
 * re-dispatches the agent — which now runs with the gate lifted
 * (metadata.approvedPriceCents) and completes the booking.
 *
 * The venue's checkout session from the first run is long dead by the time
 * a human approves, so this is a clean re-run, not a resume — the agent
 * re-reaches the card step in ~3 minutes and pays this time.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { inngest } from "@/lib/inngest";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ tripId: string; itemId: string }> },
) {
  const { tripId, itemId } = await ctx.params;
  const user = await requireUser();

  const item = await db.itineraryItem.findFirst({
    where: {
      id: itemId,
      itinerary: { trip: { ownerId: user.id, id: tripId } },
    },
    include: { booking: true },
  });
  if (!item?.booking) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const booking = item.booking;
  const meta = (booking.metadata as Record<string, unknown> | null) ?? {};
  const quoted =
    typeof meta.quotedPriceCents === "number" ? meta.quotedPriceCents : null;
  const awaitingApproval =
    booking.status === "NEEDS_REVIEW" && meta.failureReason === "price_approval";
  if (!awaitingApproval || quoted == null) {
    return NextResponse.json(
      { error: "This booking isn't waiting on a price approval." },
      { status: 400 },
    );
  }

  // Record the approval and put the booking back in flight. Approving the
  // quoted price lifts the agent's gate entirely (approvedPriceCents) — the
  // re-run pays without re-asking.
  await db.booking.update({
    where: { id: booking.id },
    data: {
      status: "SEARCHING",
      lastError: null,
      metadata: {
        ...meta,
        approvedPriceCents: quoted,
        approvedAt: new Date().toISOString(),
        failureReason: null,
      } as object,
    },
  });
  await db.itineraryItem.update({
    where: { id: itemId },
    data: { confirmationState: "SEARCHING", status: "Booking at approved price…" },
  });

  await audit({
    tripId,
    action: "BOOKING_PRICE_APPROVED",
    title: `Approved $${Math.round(quoted / 100).toLocaleString()} for ${item.title}`,
    detail: "Customer approved the venue's real price — completing the booking.",
    actorKind: "user",
    actorId: user.id,
    metadata: { bookingId: booking.id, itemId, approvedPriceCents: quoted },
  });

  nudge(tripId);

  // Same dispatch pattern as book-agent: Inngest in production, in-process
  // fire-and-forget in local dev.
  const hasInngestWorker = Boolean(process.env.INNGEST_EVENT_KEY);
  const dispatchInProcess = async () => {
    const { runBrowserBooking } = await import(
      "@/lib/bookings/browser-agent/run-booking"
    );
    void runBrowserBooking({
      tripId,
      bookingId: booking.id,
      itineraryItemId: itemId,
      userId: user.id,
    }).catch((e) =>
      console.error("[approve-price] in-process run failed:", e),
    );
  };
  if (hasInngestWorker) {
    try {
      await inngest.send({
        name: "trip/booking.agent_requested",
        data: {
          tripId,
          bookingId: booking.id,
          itineraryItemId: itemId,
          userId: user.id,
        },
      });
    } catch (err) {
      console.error(
        `[approve-price] Inngest send failed (${err instanceof Error ? err.message : err}) — falling back to in-process run.`,
      );
      await dispatchInProcess();
    }
  } else {
    await dispatchInProcess();
  }

  return NextResponse.json({
    ok: true,
    bookingId: booking.id,
    approvedPriceCents: quoted,
    status: "SEARCHING",
  });
}
