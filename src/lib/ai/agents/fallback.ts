import { db } from "@/lib/db";
import type { ItineraryItem } from "@prisma/client";
import { withAgentRun } from "../orchestrator";
import { runItineraryAgent } from "./itinerary";
import { persistItinerary } from "../conversation";
import type { ItineraryAI, TripConstraints } from "../schemas";

/**
 * The fallback agent. Triggered when one or more bookings fail or an item
 * becomes unavailable. It hands the current itinerary + the failure context
 * to the itinerary agent in refine mode, producing a new version that
 * substitutes the failed items. The booking executor then re-runs against
 * the new version automatically.
 */
export async function runFallbackForItem(args: {
  tripId: string;
  itineraryItemId: string;
  reason: string;
}) {
  const { tripId, itineraryItemId, reason } = args;
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      itineraries: {
        where: { status: "APPROVED" },
        orderBy: { version: "desc" },
        take: 1,
        include: { items: true },
      },
    },
  });
  if (!trip || !trip.destination) return;
  const current = trip.itineraries[0];
  if (!current) return;
  const failedItem = current.items.find((i) => i.id === itineraryItemId);
  if (!failedItem) return;

  return withAgentRun({
    tripId,
    agentType: "FALLBACK",
    input: {
      failedItem: failedItem.title,
      reason,
    },
    progress: "Substituting unavailable booking…",
    fn: async () => {
      const prior: ItineraryAI = {
        summary: current.aiSummary ?? "",
        totalCost: Math.round((current.totalCost ?? 0) / 100),
        perPersonCost: Math.round((current.perPersonCost ?? 0) / 100),
        items: current.items.map(itemToAI),
        changes: [],
      };

      const instruction = `The item "${failedItem.title}" (${failedItem.type}) is no longer available (${reason}). Replace it with the next-best option that fits the group, keep everything else, and call out the substitution in 'changes'.`;

      const { output } = await runItineraryAgent({
        tripId,
        destination: trip.destination!,
        constraints: (trip.constraints as TripConstraints) ?? {},
        priorItinerary: prior,
        refinementInstruction: instruction,
      });
      const newItinerary = await persistItinerary(tripId, output);
      return { itineraryId: newItinerary.id, changes: output.changes ?? [] };
    },
  });
}

function itemToAI(i: ItineraryItem) {
  return {
    type: i.type,
    title: i.title,
    description: i.description ?? null,
    location: i.location ?? null,
    address: i.address ?? null,
    startTime: i.startTime?.toISOString() ?? null,
    endTime: i.endTime?.toISOString() ?? null,
    cost: i.cost ? Math.round(i.cost / 100) : null,
    aiRationale: i.aiRationale ?? null,
    metadata: (i.metadata as Record<string, unknown> | null) ?? null,
  };
}
