import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const [messages, itinerary, agentRuns, destinationCount, memberCount] =
    await Promise.all([
      db.chatMessage.findMany({
        where: { tripId: trip.id },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      db.itinerary.findFirst({
        where: { tripId: trip.id, status: { in: ["CURRENT", "APPROVED"] } },
        orderBy: { version: "desc" },
        include: { items: { orderBy: { orderIndex: "asc" } } },
      }),
      db.agentRun.findMany({
        where: { tripId: trip.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      db.destinationOption.count({ where: { tripId: trip.id } }),
      db.tripMember.count({ where: { tripId: trip.id } }),
    ]);

  return NextResponse.json({
    trip: {
      id: trip.id,
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate?.toISOString() ?? null,
      endDate: trip.endDate?.toISOString() ?? null,
      groupSize: trip.groupSize,
      budgetTotal: trip.budgetTotal,
      budgetPerPerson: trip.budgetPerPerson,
      status: trip.status,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      createdAt: m.createdAt.toISOString(),
    })),
    itinerary: itinerary
      ? {
          id: itinerary.id,
          status: itinerary.status,
          version: itinerary.version,
          aiSummary: itinerary.aiSummary,
          totalCost: itinerary.totalCost,
          perPersonCost: itinerary.perPersonCost,
          items: itinerary.items.map((i) => ({
            id: i.id,
            type: i.type,
            title: i.title,
            description: i.description,
            location: i.location,
            startTime: i.startTime?.toISOString() ?? null,
            endTime: i.endTime?.toISOString() ?? null,
            cost: i.cost,
            status: i.status,
            confirmationState: i.confirmationState,
            aiRationale: i.aiRationale,
          })),
        }
      : null,
    agentRuns: agentRuns.map((r) => ({
      id: r.id,
      agentType: r.agentType,
      status: r.status,
      progress: r.progress,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    destinationCount,
    memberCount,
  });
}
