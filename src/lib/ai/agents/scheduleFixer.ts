import { db } from "@/lib/db";
import { withAgentRun } from "../orchestrator";
import { runItineraryAgent } from "./itinerary";
import { persistItinerary } from "../conversation";
import { detectConflicts } from "@/lib/schedule";
import type { ItineraryAI, TripConstraints } from "../schemas";
import {
  destinationBriefForAI,
  findDestination,
} from "@/lib/data/destinations";

/**
 * Schedule fixer agent. Pulls the current itinerary, runs the conflict
 * detector, and if anything's broken hands the prior itinerary to the
 * itinerary agent in refine mode with an explicit instruction to resolve
 * the listed conflicts while preserving any locked items.
 *
 * Idempotent: a clean itinerary returns early without an LLM call.
 */
export async function runScheduleFixer(tripId: string) {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      itineraries: {
        where: { status: { in: ["CURRENT", "DRAFT"] } },
        orderBy: { version: "desc" },
        take: 1,
        include: { items: true },
      },
    },
  });
  if (!trip?.destination) return null;
  const current = trip.itineraries[0];
  if (!current) return null;

  const conflicts = detectConflicts(
    current.items.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      startTime: i.startTime?.toISOString() ?? null,
      endTime: i.endTime?.toISOString() ?? null,
    })),
  );
  if (conflicts.length === 0) return { conflicts: 0 };

  return withAgentRun({
    tripId,
    agentType: "FALLBACK",
    input: { itineraryId: current.id, conflicts: conflicts as object[] },
    progress: `Resolving ${conflicts.length} schedule conflict${conflicts.length === 1 ? "" : "s"}…`,
    fn: async () => {
      const kb = findDestination(trip.destination!);
      const brief = kb ? destinationBriefForAI(kb) : null;
      const prior: ItineraryAI = {
        summary: current.aiSummary ?? "",
        totalCost: Math.round((current.totalCost ?? 0) / 100),
        perPersonCost: Math.round((current.perPersonCost ?? 0) / 100),
        items: current.items.map((i) => ({
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
        })),
        changes: [],
      };

      const instruction = [
        `The current schedule has these conflicts — resolve them while keeping the rest intact:`,
        ...conflicts.map((c, i) => `${i + 1}. ${c.reason} (items ${c.itemId} ↔ ${c.withItemId})`),
        ``,
        `Respect any item with metadata.locked === true exactly.`,
        brief ? `Available venues: ${JSON.stringify(brief.courses.map((c) => c.name).slice(0, 8))}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const { output } = await runItineraryAgent({
        tripId,
        destination: trip.destination!,
        constraints: (trip.constraints as TripConstraints) ?? {},
        priorItinerary: prior,
        refinementInstruction: instruction,
      });
      const newIt = await persistItinerary(tripId, output);
      return { itineraryId: newIt.id, resolved: conflicts.length };
    },
  });
}
