import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { generateSuggestions } from "@/lib/ai/agents/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// User-POV starter chips. These appear under the concierge's first
// message and get sent as the user's reply when tapped. They must read
// as things the customer would actually type — never as the concierge
// asking the customer for info.
const FALLBACK = [
  "Plan a luxury golf trip for 4 in Scottsdale in October",
  "Pinehurst for 6 guys, late April, ~$4K each",
  "Surprise me — top US course, long weekend in May",
];

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [itinerary, bookings, lastAssistant] = await Promise.all([
    db.itinerary.findFirst({
      where: { tripId, status: { in: ["DRAFT", "CURRENT", "APPROVED"] } },
      orderBy: { version: "desc" },
      select: { id: true },
    }),
    db.booking.findMany({
      where: { tripId, status: "CONFIRMED" },
      select: { type: true },
    }),
    db.chatMessage.findFirst({
      where: { tripId, role: "ASSISTANT" },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    }),
  ]);

  const types = new Set(bookings.map((b) => b.type));

  try {
    const { suggestions } = await generateSuggestions({
      destination: trip.destination,
      startDate: trip.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: trip.endDate?.toISOString().slice(0, 10) ?? null,
      groupSize: trip.groupSize,
      hasItinerary: Boolean(itinerary),
      hasBookedFlight: types.has("FLIGHT"),
      hasBookedHotel: types.has("LODGING"),
      hasBookedTeeTime: types.has("TEE_TIME"),
      hasBookedCar: types.has("TRANSPORT"),
      hasBookedRestaurant: types.has("DINING"),
      lastAssistantMessage: lastAssistant?.content ?? null,
    });
    return NextResponse.json({
      suggestions: suggestions.length > 0 ? suggestions : FALLBACK,
    });
  } catch (err) {
    console.error("[suggestions]", err);
    return NextResponse.json({ suggestions: FALLBACK });
  }
}
