/**
 * Shared browser-agent dispatch — used by BOTH the per-item "Book it for me"
 * route and the "Book all" master commit, so the two can never drift.
 *
 * Split in two so callers control execution:
 *   prepareAgentBooking → create/refresh the SEARCHING Booking row (sync, fast)
 *   triggerAgentRun     → fire the long-running agent (Inngest in prod, an
 *                         in-process run in local dev)
 *
 * "Book all" prepares every row up front (so the UI instantly shows each item
 * as "Pyltrix is on it…"), then runs them SEQUENTIALLY in local dev (one agent
 * at a time — concurrent in-process runs thrash a single Node process) or hands
 * them to Inngest in production, which fans them out on its own workers.
 */

import type { ItineraryItemType } from "@prisma/client";
import { db } from "@/lib/db";
import { inngest } from "@/lib/inngest";
import { audit } from "@/lib/audit";
import { isAgentBookable } from "@/lib/bookings/agent-scope";

export type AgentBookableItem = {
  id: string;
  type: ItineraryItemType;
  title: string;
  description: string | null;
  cost: number | null;
  metadata: unknown;
  booking: { id: string; status: string; metadata?: unknown } | null;
};

export type PrepareResult =
  | { ok: true; bookingId: string; idempotent: boolean }
  | { ok: false; skip: "not_bookable" | "walk_in" | "confirmed" };

/**
 * Create or refresh the SEARCHING Booking row for one item — no execution.
 * Returns the bookingId to run, or a skip reason. Idempotent: an in-flight
 * booking is returned as-is (idempotent:true) so callers never double-queue.
 */
export async function prepareAgentBooking(args: {
  tripId: string;
  userId: string;
  item: AgentBookableItem;
}): Promise<PrepareResult> {
  const { tripId, userId, item } = args;

  if (!isAgentBookable(item.type, item.title, item.description)) {
    return { ok: false, skip: "not_bookable" };
  }
  const reservationNeed = (item.metadata as { reservationNeed?: string } | null)
    ?.reservationNeed;
  if (reservationNeed === "walk_in") return { ok: false, skip: "walk_in" };

  if (item.booking) {
    const s = item.booking.status;
    if (s === "CONFIRMED") return { ok: false, skip: "confirmed" };
    // Genuinely IN FLIGHT → don't double-queue.
    if (s === "SEARCHING" || s === "PENDING" || s === "HELD") {
      return { ok: true, bookingId: item.booking.id, idempotent: true };
    }
    // A booking PAUSED for price approval is completed by the approve-price
    // route (the "Approve & book" button), not a re-fire — leave it as-is.
    const failureReason = (item.booking.metadata as { failureReason?: string } | null)
      ?.failureReason;
    if (s === "NEEDS_REVIEW" && failureReason === "price_approval") {
      return { ok: true, bookingId: item.booking.id, idempotent: true };
    }
    // ANY other finished state — NEEDS_REVIEW from form_not_found / timeout, or
    // a FAILED attempt — RE-FIRES on tap. The customer asked to book it again,
    // so we always try: a golf course wrongly tagged "reservations by phone"
    // must re-attempt, never stay stuck. Falls through to reset + re-run below.
  }

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
          itineraryItemId: item.id,
          type: item.type,
          provider: "BROWSER_AGENT",
          status: "SEARCHING",
          cost: item.cost,
        },
      });

  await db.itineraryItem.update({
    where: { id: item.id },
    data: { confirmationState: "SEARCHING", status: "Pyltrix is on it…" },
  });

  await audit({
    tripId,
    action: "BOOKING_REQUESTED",
    title: `Booking ${item.title}`,
    detail: "Customer asked Pyltrix to handle the booking.",
    actorKind: "user",
    actorId: userId,
    metadata: { bookingId: booking.id, itemId: item.id },
  });

  return { ok: true, bookingId: booking.id, idempotent: false };
}

/** True when an Inngest worker is wired (production). */
export function hasInngestWorker(): boolean {
  return Boolean(process.env.INNGEST_EVENT_KEY);
}

/**
 * Fire the agent for a single prepared booking. In production hands the event
 * to Inngest; in local dev runs the agent in-process (fire-and-forget) so the
 * customer sees progress without also running the Inngest dev CLI.
 */
export async function triggerAgentRun(args: {
  tripId: string;
  bookingId: string;
  itineraryItemId: string;
  userId: string;
}): Promise<void> {
  if (hasInngestWorker()) {
    try {
      await inngest.send({
        name: "trip/booking.agent_requested",
        data: {
          tripId: args.tripId,
          bookingId: args.bookingId,
          itineraryItemId: args.itineraryItemId,
          userId: args.userId,
        },
      });
      return;
    } catch (err) {
      console.error(
        `[dispatch-agent] Inngest send failed (${err instanceof Error ? err.message : err}) — running in-process.`,
      );
    }
  }
  const { runBrowserBooking } = await import(
    "@/lib/bookings/browser-agent/run-booking"
  );
  void runBrowserBooking({
    tripId: args.tripId,
    bookingId: args.bookingId,
    itineraryItemId: args.itineraryItemId,
    userId: args.userId,
  }).catch((e) => console.error("[dispatch-agent] in-process run failed:", e));
}

/**
 * Run a batch of prepared bookings to completion, SEQUENTIALLY, in local dev —
 * one agent at a time so they don't starve each other in a single process.
 * Fire-and-forget the whole loop (don't await it in a request handler). In
 * production this isn't used: callers send Inngest events instead.
 */
export function runAgentBatchSequentiallyInBackground(
  jobs: { tripId: string; bookingId: string; itineraryItemId: string; userId: string }[],
): void {
  void (async () => {
    const { runBrowserBooking } = await import(
      "@/lib/bookings/browser-agent/run-booking"
    );
    for (const job of jobs) {
      try {
        await runBrowserBooking(job);
      } catch (e) {
        console.error(
          `[dispatch-agent] batch run failed for ${job.itineraryItemId}:`,
          e,
        );
      }
    }
  })();
}
