import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { runSummaryAgent } from "@/lib/ai/agents/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const it = await db.itinerary.findFirst({
    where: { tripId, status: "APPROVED" },
    orderBy: { version: "desc" },
    include: { items: { include: { booking: true }, orderBy: { orderIndex: "asc" } } },
  });
  if (!it) {
    return NextResponse.json({ error: "no approved itinerary" }, { status: 400 });
  }

  const summary = await runSummaryAgent({
    tripId,
    context: {
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate?.toISOString() ?? null,
      endDate: trip.endDate?.toISOString() ?? null,
      groupSize: trip.groupSize,
      totalCost: it.totalCost,
      perPersonCost: it.perPersonCost,
      items: it.items.map((i) => ({
        type: i.type,
        title: i.title,
        startTime: i.startTime?.toISOString() ?? null,
        cost: i.cost,
        status: i.status ?? null,
        confirmationCode: i.booking?.confirmationCode ?? null,
      })),
      substitutions: ((it.diff as { changes?: string[] } | null)?.changes) ?? [],
    },
  });

  await db.tripSummary.upsert({
    where: { tripId },
    create: {
      tripId,
      itineraryId: it.id,
      content: summary.content,
      highlights: { items: summary.highlights, substitutions: summary.substitutions },
      totalCost: it.totalCost,
      perPersonCost: it.perPersonCost,
    },
    update: {
      itineraryId: it.id,
      content: summary.content,
      highlights: { items: summary.highlights, substitutions: summary.substitutions },
      totalCost: it.totalCost,
      perPersonCost: it.perPersonCost,
      generatedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true });
}
