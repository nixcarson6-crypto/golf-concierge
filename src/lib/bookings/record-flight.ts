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

  // Auto-supersede: when a new flight is ticketed on this trip, cancel
  // any already-confirmed flight bookings — both in our DB and on
  // Duffel's side so the airline doesn't think the customer has two
  // active reservations. Duffel cancellation is best-effort: if it
  // fails (network blip, already cancelled, etc.) we still proceed
  // with the local-state cleanup so the workspace reflects reality.
  const supersededAt = new Date();
  const supersededBy = args.bookingReference;
  const priorBookings = await db.booking.findMany({
    where: {
      tripId: args.tripId,
      type: "FLIGHT",
      status: "CONFIRMED",
    },
    select: { id: true, providerReference: true, metadata: true },
  });
  for (const prior of priorBookings) {
    // Best-effort Duffel cancel — never let a partner API failure
    // block recording the new booking.
    if (prior.providerReference) {
      try {
        const { cancelOrder } = await import(
          "@/lib/bookings/providers/duffel-cancel"
        );
        const result = await cancelOrder(prior.providerReference);
        if (!result.ok) {
          console.warn(
            `[supersede] Duffel cancel for ${prior.providerReference} failed:`,
            result.error,
          );
        }
      } catch (err) {
        console.warn(`[supersede] Duffel cancel threw:`, err);
      }
    }
    await db.booking.update({
      where: { id: prior.id },
      data: {
        status: "CANCELLED",
        metadata: {
          ...((prior.metadata as Record<string, unknown> | null) ?? {}),
          supersededAt: supersededAt.toISOString(),
          supersededBy,
        },
      },
    });
  }
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
        // Flight tickets are paid upfront — Pyltrix charges via Stripe
        // (production) or via Duffel's test balance (sandbox).
        // Restaurants, most resort hotels, and tee times settle at
        // the venue; those carry paymentMode: "pay_at_property".
        paymentMode: "pay_now",
      },
    },
  });

  return { itineraryItemId: item.id, bookingId: booking.id };
}
