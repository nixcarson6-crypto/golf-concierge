/**
 * Persist a confirmed Duffel flight booking as a Trip itinerary item + Booking
 * row. Called immediately after a successful POST /air/orders so the booking
 * shows up in the Live Trip panel and is auditable.
 */

import { db } from "@/lib/db";
import type { BookedSlice } from "@/lib/bookings/providers/duffel-book";

export type RecordFlightArgs = {
  tripId: string;
  orderId: string;
  bookingReference: string;
  totalAmount: number; // cents
  currency: string;
  airline: string;
  airlineCode?: string | null;
  passengers: number;
  passengerNames?: string[];
  slicesSummary: string;
  bookedSlices?: BookedSlice[];
  isSandbox?: boolean;
  rationale?: string;
};

export async function recordFlightBooking(args: RecordFlightArgs) {
  // Find the current/draft itinerary for the trip, or create a v1 wrapper so
  // the booking has somewhere to live even if no full itinerary exists yet.
  let itinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: { in: ["DRAFT", "CURRENT"] } },
    orderBy: { version: "desc" },
  });
  if (!itinerary) {
    itinerary = await db.itinerary.create({
      data: {
        tripId: args.tripId,
        version: 1,
        status: "DRAFT",
      },
    });
  }

  // Auto-supersede: when a new flight is ticketed on this trip, mark any
  // already-confirmed flight bookings as CANCELLED so the Live Trip shows
  // the most recent option instead of stacking duplicates. The AI typically
  // does this after finding a better deal — the workspace should reflect
  // that immediately without the user having to clean up the old row.
  const supersededAt = new Date();
  const supersededBy = args.bookingReference;
  await db.booking.updateMany({
    where: {
      tripId: args.tripId,
      type: "FLIGHT",
      status: "CONFIRMED",
    },
    data: { status: "CANCELLED" },
  });
  const supersededItems = await db.itineraryItem.findMany({
    where: {
      itinerary: { tripId: args.tripId },
      type: "FLIGHT",
      confirmationState: "CONFIRMED",
    },
    select: { id: true, metadata: true },
  });
  for (const it of supersededItems) {
    await db.itineraryItem.update({
      where: { id: it.id },
      data: {
        confirmationState: "CANCELLED",
        status: "Superseded",
        metadata: {
          ...((it.metadata as Record<string, unknown> | null) ?? {}),
          supersededAt: supersededAt.toISOString(),
          supersededBy,
        },
      },
    });
  }

  const item = await db.itineraryItem.create({
    data: {
      itineraryId: itinerary.id,
      type: "FLIGHT",
      title: `${args.airline} · ${args.slicesSummary}`,
      description: `${args.passengers} passenger${args.passengers === 1 ? "" : "s"} · confirmed`,
      cost: args.totalAmount,
      status: "Confirmed",
      confirmationState: "CONFIRMED",
      aiRationale: args.rationale ?? null,
      metadata: {
        airline: args.airline,
        passengers: args.passengers,
        duffelOrderId: args.orderId,
      },
    },
  });

  const booking = await db.booking.create({
    data: {
      tripId: args.tripId,
      itineraryItemId: item.id,
      provider: "DUFFEL",
      providerReference: args.orderId,
      type: "FLIGHT",
      status: "CONFIRMED",
      confirmationCode: args.bookingReference,
      cost: args.totalAmount,
      confirmedAt: new Date(),
      metadata: {
        airline: args.airline,
        airlineCode: args.airlineCode ?? null,
        slicesSummary: args.slicesSummary,
        passengerNames: args.passengerNames ?? [],
        bookedSlices: args.bookedSlices ?? [],
        isSandbox: args.isSandbox ?? false,
      },
    },
  });

  return { itineraryItemId: item.id, bookingId: booking.id };
}
