import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { ConciergeWorkspace } from "@/components/concierge/workspace";

export const dynamic = "force-dynamic";

export default async function TripCommandCenterPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    notFound();
  }
  const trip = access.trip;
  if (!trip) notFound();

  const [messages, currentItinerary, recentAgentRuns, destinationOptions, members] =
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
      db.destinationOption.findMany({
        where: { tripId: trip.id },
        orderBy: { rank: "asc" },
      }),
      db.tripMember.findMany({ where: { tripId: trip.id } }),
    ]);

  return (
    <ConciergeWorkspace
      tripId={trip.id}
      initialTrip={{
        id: trip.id,
        title: trip.title,
        destination: trip.destination,
        startDate: trip.startDate?.toISOString() ?? null,
        endDate: trip.endDate?.toISOString() ?? null,
        groupSize: trip.groupSize,
        budgetTotal: trip.budgetTotal,
        budgetPerPerson: trip.budgetPerPerson,
        status: trip.status,
      }}
      initialMessages={messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        metadata: (m.metadata as Record<string, unknown>) ?? null,
        createdAt: m.createdAt.toISOString(),
      }))}
      initialItinerary={
        currentItinerary
          ? {
              id: currentItinerary.id,
              status: currentItinerary.status,
              version: currentItinerary.version,
              aiSummary: currentItinerary.aiSummary,
              totalCost: currentItinerary.totalCost,
              perPersonCost: currentItinerary.perPersonCost,
              items: currentItinerary.items.map((i) => ({
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
          : null
      }
      initialAgentRuns={recentAgentRuns.map((r) => ({
        id: r.id,
        agentType: r.agentType,
        status: r.status,
        progress: r.progress,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
      }))}
      destinationCount={destinationOptions.length}
      memberCount={members.length}
    />
  );
}
