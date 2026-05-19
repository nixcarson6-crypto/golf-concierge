/**
 * Persist a confirmed restaurant reservation as a Trip itinerary item +
 * Booking row.
 */

import { db } from "@/lib/db";

export type RecordRestaurantArgs = {
  tripId: string;
  bookingReference: string;
  providerReference: string;
  restaurantName: string;
  city: string | null;
  dateTimeISO: string;
  partySize: number;
  cost?: number; // cents; usually null for reservations (no charge to hold)
  currency?: string;
  isStub?: boolean;
  rationale?: string;
};

export async function recordRestaurantBooking(args: RecordRestaurantArgs) {
  let itinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: { in: ["DRAFT", "CURRENT"] } },
    orderBy: { version: "desc" },
  });
  if (!itinerary) {
    itinerary = await db.itinerary.create({
      data: { tripId: args.tripId, version: 1, status: "DRAFT" },
    });
  }

  const start = new Date(args.dateTimeISO);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const item = await db.itineraryItem.create({
    data: {
      itineraryId: itinerary.id,
      type: "DINING",
      title: args.restaurantName + (args.city ? ` · ${args.city}` : ""),
      description: `Party of ${args.partySize} · ${start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      location: args.city,
      startTime: start,
      endTime: end,
      cost: args.cost ?? null,
      status: "Reserved",
      confirmationState: "CONFIRMED",
      aiRationale: args.rationale ?? null,
      metadata: {
        restaurantName: args.restaurantName,
        partySize: args.partySize,
        isStub: args.isStub ?? false,
      },
    },
  });

  await db.booking.create({
    data: {
      tripId: args.tripId,
      itineraryItemId: item.id,
      provider: "OPENTABLE",
      providerReference: args.providerReference,
      type: "DINING",
      status: "CONFIRMED",
      confirmationCode: args.bookingReference,
      cost: args.cost ?? null,
      confirmedAt: new Date(),
      metadata: { restaurantName: args.restaurantName, isStub: args.isStub ?? false },
    },
  });

  return { itineraryItemId: item.id };
}
