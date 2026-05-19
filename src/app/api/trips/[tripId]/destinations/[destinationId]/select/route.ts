import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { runItineraryAgent } from "@/lib/ai/agents/itinerary";
import { persistItinerary } from "@/lib/ai/conversation";
import type { TripConstraints } from "@/lib/ai/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ tripId: string; destinationId: string }>;
  },
) {
  const { tripId, destinationId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const dest = await db.destinationOption.findFirst({
    where: { id: destinationId, tripId },
  });
  if (!dest) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.$transaction([
    db.destinationOption.updateMany({
      where: { tripId },
      data: { selected: false },
    }),
    db.destinationOption.update({
      where: { id: destinationId },
      data: { selected: true },
    }),
    db.trip.update({
      where: { id: tripId },
      data: { destination: dest.name, status: "PLANNING" },
    }),
  ]);

  // Fire-and-forget itinerary draft. The Inngest path is preferred in prod;
  // we run it in-process here for the demo so even without Inngest deployed
  // the user sees an itinerary appear quickly.
  void (async () => {
    try {
      const constraints = (trip.constraints as TripConstraints | null) ?? {};
      const { output } = await runItineraryAgent({
        tripId,
        destination: dest.name,
        constraints,
      });
      await persistItinerary(tripId, output);
    } catch (err) {
      console.error("[itinerary draft after destination select]", err);
    }
  })();

  return NextResponse.json({ ok: true });
}
