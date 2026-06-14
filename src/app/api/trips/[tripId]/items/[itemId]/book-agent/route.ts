/**
 * "Book it for me" — kicks off the autonomous browser-agent booking flow
 * for a single itinerary item.
 *
 * The route does the SYNC half: auth, idempotency, create the Booking +
 * link an AgentRun, then emit an Inngest event. The agent loop itself
 * (5–10 min) runs in the Inngest worker (see jobs/onBookingAgentRequested)
 * so this handler returns within ~100ms and the customer gets instant
 * UI feedback.
 *
 * Returns the booking id so the dialog can subscribe to its live status.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { isAgentBookable } from "@/lib/bookings/agent-scope";
import { prepareAgentBooking, triggerAgentRun } from "@/lib/bookings/dispatch-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ tripId: string; itemId: string }> },
) {
  const { tripId, itemId } = await ctx.params;
  const user = await requireUser();

  // Auth + load item in a single query (relation filter on Trip.ownerId
  // enforces access without a second round-trip).
  const item = await db.itineraryItem.findFirst({
    where: {
      id: itemId,
      itinerary: { trip: { ownerId: user.id, id: tripId } },
    },
    include: { booking: true },
  });
  if (!item) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // The agent is scoped to hotels, golf, and car rentals (shared scope so
  // the UI + this route never drift). Restaurants/activities are
  // suggestions; per-ride Uber/chauffeur transfers aren't browser-bookable.
  // Reject anything else so a stray call can't kick off a wasteful run.
  if (!isAgentBookable(item.type, item.title, item.description)) {
    return NextResponse.json(
      {
        error:
          "This isn't something the agent books — restaurants/activities are reserved directly with the venue, and rides are summoned in-app.",
      },
      { status: 400 },
    );
  }

  // Walk-in venues don't take reservations — running the agent on them
  // just wastes time. Surface a clear message instead.
  const reservationNeed = (item.metadata as { reservationNeed?: string } | null)
    ?.reservationNeed;
  if (reservationNeed === "walk_in") {
    return NextResponse.json(
      {
        error:
          "This venue is walk-in — Google doesn't show a reservation system, so no booking is needed.",
      },
      { status: 400 },
    );
  }

  // Create/refresh the SEARCHING Booking row (shared with Book All so the two
  // paths never drift). Idempotent: an in-flight booking returns as-is.
  const prepared = await prepareAgentBooking({
    tripId,
    userId: user.id,
    item,
  });
  if (!prepared.ok) {
    // Shouldn't happen (we validated above) but stay honest if it does.
    return NextResponse.json(
      { error: "This isn't something the agent books." },
      { status: 400 },
    );
  }

  nudge(tripId);

  // Already in flight → don't re-fire the run, just hand back the row.
  if (prepared.idempotent) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      bookingId: prepared.bookingId,
      status: "SEARCHING",
    });
  }

  // Fire the long-running agent (Inngest in prod, in-process in local dev).
  await triggerAgentRun({
    tripId,
    bookingId: prepared.bookingId,
    itineraryItemId: itemId,
    userId: user.id,
  });

  return NextResponse.json({
    ok: true,
    bookingId: prepared.bookingId,
    status: "SEARCHING",
  });
}
