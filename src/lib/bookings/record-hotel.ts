/**
 * Persist a confirmed hotel booking as a Trip itinerary item + Booking row.
 * Same shape as record-flight; LODGING type, BOOKING_DOT_COM provider until
 * we add a HOTELBEDS enum value (follow-up migration).
 */

import { db } from "@/lib/db";

export type RecordHotelArgs = {
  tripId: string;
  bookingReference: string;
  providerReference: string;
  totalAmount: number; // cents
  currency: string;
  hotelName: string;
  city: string | null;
  checkIn: string; // YYYY-MM-DD
  checkOut: string;
  rooms: number;
  guests: number;
  isStub?: boolean;
  rationale?: string;
};

export async function recordHotelBooking(args: RecordHotelArgs) {
  let itinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: { in: ["DRAFT", "CURRENT"] } },
    orderBy: { version: "desc" },
  });
  if (!itinerary) {
    itinerary = await db.itinerary.create({
      data: { tripId: args.tripId, version: 1, status: "DRAFT" },
    });
  }

  const item = await db.itineraryItem.create({
    data: {
      itineraryId: itinerary.id,
      type: "LODGING",
      title: args.hotelName + (args.city ? ` · ${args.city}` : ""),
      description: `${args.rooms} room${args.rooms === 1 ? "" : "s"} · ${args.guests} guest${args.guests === 1 ? "" : "s"} · ${args.checkIn} → ${args.checkOut}`,
      location: args.city,
      startTime: new Date(args.checkIn),
      endTime: new Date(args.checkOut),
      cost: args.totalAmount,
      status: "Confirmed",
      confirmationState: "CONFIRMED",
      aiRationale: args.rationale ?? null,
      metadata: {
        hotelName: args.hotelName,
        rooms: args.rooms,
        guests: args.guests,
        isStub: args.isStub ?? false,
      },
    },
  });

  await db.booking.create({
    data: {
      tripId: args.tripId,
      itineraryItemId: item.id,
      provider: "BOOKING_DOT_COM",
      providerReference: args.providerReference,
      type: "LODGING",
      status: "CONFIRMED",
      confirmationCode: args.bookingReference,
      cost: args.totalAmount,
      confirmedAt: new Date(),
      metadata: { hotelName: args.hotelName, isStub: args.isStub ?? false },
    },
  });

  return { itineraryItemId: item.id };
}
