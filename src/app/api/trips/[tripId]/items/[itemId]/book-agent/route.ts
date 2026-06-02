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

  // Idempotency — never re-queue a booking that's already in flight or done.
  if (item.booking) {
    const status = item.booking.status;
    if (
      status === "CONFIRMED" ||
      status === "SEARCHING" ||
      status === "PENDING" ||
      status === "HELD" ||
      status === "NEEDS_REVIEW"
    ) {
      return NextResponse.json({
        ok: true,
        idempotent: true,
        bookingId: item.booking.id,
        status,
      });
    }
  }

  // Create (or upsert into a fresh attempt) the Booking row. If a prior
  // FAILED/CANCELLED row exists, reuse the same id so the executor's
  // 1:1 (itineraryItemId → Booking) invariant holds.
  const booking = item.booking
    ? await db.booking.update({
        where: { id: item.booking.id },
        data: {
          provider: "BROWSER_AGENT",
          status: "SEARCHING",
          lastError: null,
          confirmationCode: null,
          screenshotUrl: null,
          confirmedAt: null,
        },
      })
    : await db.booking.create({
        data: {
          tripId,
          itineraryItemId: itemId,
          type: item.type,
          provider: "BROWSER_AGENT",
          status: "SEARCHING",
          cost: item.cost,
        },
      });

  await db.itineraryItem.update({
    where: { id: itemId },
    data: { confirmationState: "SEARCHING", status: "Pyltrix is on it…" },
  });

  await audit({
    tripId,
    action: "BOOKING_REQUESTED",
    title: `Booking ${item.title}`,
    detail: "Customer asked Pyltrix to handle the booking.",
    actorKind: "user",
    actorId: user.id,
    metadata: { bookingId: booking.id, itemId },
  });

  nudge(tripId);

  // Fire the long-running job. Don't await — Inngest's worker picks it up.
  // If Inngest isn't configured locally (no INNGEST_EVENT_KEY, no worker
  // running), fall back to a fire-and-forget async run so local dev still
  // works without `pnpm dlx inngest-cli dev`. In production with Inngest
  // configured the event-based path is used as designed.
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
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("401") ||
      msg.includes("Event key not found") ||
      msg.includes("ECONNREFUSED")
    ) {
      console.warn(
        "[book-agent] Inngest not available — running agent locally (fire-and-forget). In production, set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY and run the worker.",
      );
      // Fire-and-forget — the route still returns immediately so the UI
      // shows live progress via the SSE bridge. Errors inside are logged
      // by runBrowserBooking itself.
      const { runBrowserBooking } = await import(
        "@/lib/bookings/browser-agent/run-booking"
      );
      void runBrowserBooking({
        tripId,
        bookingId: booking.id,
        itineraryItemId: itemId,
        userId: user.id,
      }).catch((e) =>
        console.error("[book-agent] local fire-and-forget failed:", e),
      );
    } else {
      throw err;
    }
  }

  return NextResponse.json({
    ok: true,
    bookingId: booking.id,
    status: "SEARCHING",
  });
}
