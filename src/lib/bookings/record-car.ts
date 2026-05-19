/**
 * Persist a confirmed rental car booking as a Trip itinerary item + Booking row.
 */

import { db } from "@/lib/db";

export type RecordCarArgs = {
  tripId: string;
  bookingReference: string;
  providerReference: string;
  totalAmount: number; // cents
  currency: string;
  vendor: string; // "Avis", "Hertz", etc.
  carClass: string; // "Midsize", "Luxury SUV"
  pickupAirport: string; // IATA
  pickupISO: string;
  returnISO: string;
  isStub?: boolean;
  rationale?: string;
};

export async function recordCarBooking(args: RecordCarArgs) {
  let itinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: { in: ["DRAFT", "CURRENT"] } },
    orderBy: { version: "desc" },
  });
  if (!itinerary) {
    itinerary = await db.itinerary.create({
      data: { tripId: args.tripId, version: 1, status: "DRAFT" },
    });
  }

  const pickup = new Date(args.pickupISO);
  const ret = new Date(args.returnISO);

  const item = await db.itineraryItem.create({
    data: {
      itineraryId: itinerary.id,
      type: "TRANSPORT",
      title: `${args.vendor} · ${args.carClass}`,
      description: `Pickup ${args.pickupAirport} ${pickup.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Return ${ret.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      location: args.pickupAirport,
      startTime: pickup,
      endTime: ret,
      cost: args.totalAmount,
      status: "Confirmed",
      confirmationState: "CONFIRMED",
      aiRationale: args.rationale ?? null,
      metadata: {
        vendor: args.vendor,
        carClass: args.carClass,
        pickupAirport: args.pickupAirport,
        isStub: args.isStub ?? false,
      },
    },
  });

  await db.booking.create({
    data: {
      tripId: args.tripId,
      itineraryItemId: item.id,
      provider: "INTERNAL",
      providerReference: args.providerReference,
      type: "TRANSPORT",
      status: "CONFIRMED",
      confirmationCode: args.bookingReference,
      cost: args.totalAmount,
      confirmedAt: new Date(),
      metadata: {
        vendor: args.vendor,
        carClass: args.carClass,
        isStub: args.isStub ?? false,
      },
    },
  });

  return { itineraryItemId: item.id };
}
