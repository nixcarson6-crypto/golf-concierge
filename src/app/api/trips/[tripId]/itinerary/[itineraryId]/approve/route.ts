import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { executeItineraryBookings } from "@/lib/bookings/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ tripId: string; itineraryId: string }>;
  },
) {
  const { tripId, itineraryId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const itinerary = await db.itinerary.findFirst({
    where: { id: itineraryId, tripId, status: "CURRENT" },
  });
  if (!itinerary) {
    return NextResponse.json({ error: "no current itinerary" }, { status: 404 });
  }

  await db.$transaction([
    db.itinerary.update({
      where: { id: itinerary.id },
      data: { status: "APPROVED" },
    }),
    db.trip.update({
      where: { id: tripId },
      data: { status: "BOOKING" },
    }),
  ]);

  // Fire-and-forget booking executor. In production this is also reachable
  // via the Inngest 'trip/itinerary.approved' event; running it here too means
  // the demo works without Inngest credentials.
  void executeItineraryBookings(itinerary.id)
    .then(() =>
      db.trip.update({ where: { id: tripId }, data: { status: "BOOKED" } }),
    )
    .catch((err) => console.error("[approve → book]", err));

  return NextResponse.json({ ok: true });
}
