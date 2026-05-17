import { db } from "@/lib/db";
import type { ItineraryItem } from "@prisma/client";
import { partnerFor } from "./registry";
import { runFallbackForItem } from "@/lib/ai/agents/fallback";

/**
 * Runs the booking flow for an approved itinerary. For each itinerary item
 * with no booking yet:
 *   - creates a PENDING Booking row
 *   - asks the registered partner to book()
 *   - persists the result and flips the itinerary item's confirmationState
 *
 * Runs in parallel across items. Failures are isolated: one failed booking
 * does not block the rest. Failed items get their itinerary state set to
 * FAILED so the fallback agent can pick them up for re-optimization.
 */
export async function executeItineraryBookings(itineraryId: string) {
  const itinerary = await db.itinerary.findUnique({
    where: { id: itineraryId },
    include: { items: { include: { booking: true } } },
  });
  if (!itinerary) throw new Error(`Itinerary ${itineraryId} not found`);

  const pending = itinerary.items.filter(
    (i) => !i.booking || i.booking.status === "FAILED",
  );

  await Promise.all(pending.map((item) => bookOne(itinerary.tripId, item)));

  return db.itinerary.findUnique({
    where: { id: itineraryId },
    include: { items: { include: { booking: true } } },
  });
}

async function bookOne(
  tripId: string,
  item: ItineraryItem & { booking: { id: string; status: string } | null },
) {
  const partner = partnerFor(item.type);

  // Reuse the existing Booking row if there's one from a prior failed attempt.
  const existing = item.booking
    ? await db.booking.findUnique({ where: { id: item.booking.id } })
    : null;
  const booking =
    existing ??
    (await db.booking.create({
      data: {
        tripId,
        itineraryItemId: item.id,
        provider: partner.provider,
        type: item.type,
        status: "SEARCHING",
        cost: item.cost,
      },
    }));

  await db.itineraryItem.update({
    where: { id: item.id },
    data: { confirmationState: "SEARCHING" },
  });

  try {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const result = await partner.book({
      tripId,
      itineraryItemId: item.id,
      type: item.type,
      title: item.title,
      startTime: item.startTime,
      endTime: item.endTime,
      party: typeof meta.partySize === "number" ? meta.partySize : null,
      budget: item.cost,
      location: item.location,
      metadata: meta,
    });

    await db.booking.update({
      where: { id: booking.id },
      data: {
        provider: result.provider,
        providerReference: result.providerReference,
        confirmationCode: result.confirmationCode,
        cost: result.cost,
        status: result.status,
        heldUntil: result.heldUntil,
        confirmedAt: result.status === "CONFIRMED" ? new Date() : null,
        metadata: result.raw as object | undefined,
        attempts: { increment: 1 },
      },
    });

    await db.itineraryItem.update({
      where: { id: item.id },
      data: {
        confirmationState: result.status === "CONFIRMED" ? "CONFIRMED" : "HOLDING",
        status: result.status === "CONFIRMED" ? "Confirmed" : "Holding…",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.booking.update({
      where: { id: booking.id },
      data: {
        status: "FAILED",
        lastError: msg,
        attempts: { increment: 1 },
      },
    });
    await db.itineraryItem.update({
      where: { id: item.id },
      data: { confirmationState: "FAILED", status: "Re-optimizing…" },
    });
    // Hand off to the fallback agent — fire-and-forget so other bookings
    // continue in parallel. The fallback produces a new itinerary version
    // which the executor can be re-run against.
    void runFallbackForItem({
      tripId,
      itineraryItemId: item.id,
      reason: msg.slice(0, 200),
    }).catch((err) => console.error("[fallback agent]", err));
  }
}
