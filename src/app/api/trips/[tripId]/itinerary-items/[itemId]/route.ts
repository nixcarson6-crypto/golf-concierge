/**
 * Soft-delete an itinerary item from the trip. Removes the line item
 * AND any associated booking (so totals + the "Booked" checklist update
 * in lockstep). Idempotent — deleting an already-gone item returns 200.
 *
 * For real (non-sandbox) DUFFEL flight bookings, we ALSO fire a Duffel
 * cancellation so the airline isn't holding a ticket the customer
 * thinks they removed. Best-effort: a partner-API failure still lets
 * the local-state cleanup proceed.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ tripId: string; itemId: string }> },
) {
  const { tripId, itemId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    select: { id: true },
  });
  if (!trip) return new Response("not found", { status: 404 });

  const item = await db.itineraryItem.findFirst({
    where: {
      id: itemId,
      itinerary: { tripId },
    },
    select: { id: true, itineraryId: true, type: true },
  });
  if (!item) {
    // Already gone — return ok so the UI's optimistic remove stays.
    return new Response(JSON.stringify({ ok: true, alreadyGone: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Find any booking tied to this itinerary item so we can cancel and
  // soft-delete it alongside.
  const booking = await db.booking.findFirst({
    where: { itineraryItemId: item.id, tripId },
    select: {
      id: true,
      provider: true,
      providerReference: true,
      status: true,
      type: true,
      metadata: true,
    },
  });

  // If there's a real Duffel flight booking, fire the cancel on
  // Duffel's side. Best-effort — never block the local delete on
  // partner API outages.
  if (
    booking &&
    booking.type === "FLIGHT" &&
    booking.provider === "DUFFEL" &&
    booking.providerReference &&
    booking.status === "CONFIRMED"
  ) {
    try {
      const { cancelOrder } = await import(
        "@/lib/bookings/providers/duffel-cancel"
      );
      const result = await cancelOrder(booking.providerReference);
      if (!result.ok) {
        console.warn(
          `[itinerary-delete] Duffel cancel failed for ${booking.providerReference}:`,
          result.error,
        );
      }
    } catch (err) {
      console.warn("[itinerary-delete] Duffel cancel threw:", err);
    }
  }

  // Delete the booking first (FK from itineraryItem) then the item.
  if (booking) {
    await db.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED" },
    });
  }
  await db.itineraryItem.delete({ where: { id: item.id } });
  nudge(tripId);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
