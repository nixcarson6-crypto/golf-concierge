/**
 * Persist a confirmed golf tee time as a Trip itinerary item + Booking row.
 */

import { db } from "@/lib/db";

export type RecordTeeTimeArgs = {
  tripId: string;
  bookingReference: string;
  providerReference: string;
  totalAmount: number; // cents (greenFee × players)
  currency: string;
  courseName: string;
  teeOffISO: string;
  players: number;
  isStub?: boolean;
  rationale?: string;
};

export async function recordTeeTimeBooking(args: RecordTeeTimeArgs) {
  let itinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: { in: ["DRAFT", "CURRENT"] } },
    orderBy: { version: "desc" },
  });
  if (!itinerary) {
    itinerary = await db.itinerary.create({
      data: { tripId: args.tripId, version: 1, status: "DRAFT" },
    });
  }

  const tee = new Date(args.teeOffISO);
  const end = new Date(tee.getTime() + 4.5 * 60 * 60 * 1000);

  const item = await db.itineraryItem.create({
    data: {
      itineraryId: itinerary.id,
      type: "TEE_TIME",
      title: args.courseName,
      description: `${args.players} player${args.players === 1 ? "" : "s"} · ${tee.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      location: args.courseName,
      startTime: tee,
      endTime: end,
      cost: args.totalAmount,
      status: "Confirmed",
      confirmationState: "CONFIRMED",
      aiRationale: args.rationale ?? null,
      metadata: {
        courseName: args.courseName,
        players: args.players,
        isStub: args.isStub ?? false,
      },
    },
  });

  await db.booking.create({
    data: {
      tripId: args.tripId,
      itineraryItemId: item.id,
      provider: "GOLFNOW",
      providerReference: args.providerReference,
      type: "TEE_TIME",
      status: "CONFIRMED",
      confirmationCode: args.bookingReference,
      cost: args.totalAmount,
      confirmedAt: new Date(),
      metadata: { courseName: args.courseName, isStub: args.isStub ?? false },
    },
  });

  return { itineraryItemId: item.id };
}
