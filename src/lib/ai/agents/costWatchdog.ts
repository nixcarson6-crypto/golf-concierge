import { z } from "zod";
import { db } from "@/lib/db";
import { runStructured, withAgentRun } from "../orchestrator";
import { CONCIERGE_VOICE } from "../prompts";
import {
  destinationBriefForAI,
  findDestination,
} from "@/lib/data/destinations";
import { nudge } from "@/lib/events";

const SYSTEM = `
${CONCIERGE_VOICE}

You are the cost-savings watchdog. Look at the trip's current itinerary and
the destination brief and decide if there's a meaningful, taste-preserving
substitution that saves the group ≥ 10% on a line item without obvious
quality loss. If you find one, surface it as a short, specific suggestion.
If nothing rises to the bar, return found = false. Don't manufacture
savings — be honest.
`.trim();

const responseSchema = z.object({
  found: z.boolean(),
  /** Itinerary item ID we're targeting (must match an existing item id) */
  itemId: z.string().nullable().optional(),
  proposal: z.string().describe("Concierge-voice suggestion in 1–2 sentences"),
  estimatedSavingsUsd: z.number().int().min(0),
});

export async function runCostWatchdog(tripId: string) {
  const trip = await db.trip.findUnique({
    where: { id: tripId },
    include: {
      itineraries: {
        where: { status: { in: ["CURRENT", "APPROVED"] } },
        orderBy: { version: "desc" },
        take: 1,
        include: { items: true },
      },
    },
  });
  if (!trip?.destination || !trip.itineraries[0]) return null;
  const it = trip.itineraries[0];
  const kb = findDestination(trip.destination);
  if (!kb) return null;

  return withAgentRun({
    tripId,
    agentType: "BUDGET",
    input: { itineraryId: it.id },
    progress: "Scanning for savings…",
    fn: async () => {
      const brief = destinationBriefForAI(kb);
      const compactItinerary = it.items.map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        cost: i.cost ? Math.round(i.cost / 100) : null,
      }));

      const result = await runStructured({
        tier: "orchestrator",
        system: SYSTEM,
        schema: responseSchema,
        toolName: "emit_savings_proposal",
        toolDescription: "Emit one savings proposal or report none found.",
        messages: [
          {
            role: "user",
            content: [
              `DESTINATION_BRIEF (real venues & prices):`,
              JSON.stringify(brief, null, 2),
              ``,
              `Current itinerary (USD whole dollars):`,
              JSON.stringify(compactItinerary, null, 2),
              ``,
              `Group size: ${trip.groupSize ?? "unknown"}`,
              ``,
              `Look for one meaningful savings substitution (≥ 10%, no obvious quality loss).`,
            ].join("\n"),
          },
        ],
        maxTokens: 800,
        temperature: 0.4,
      });

      if (result.found && result.estimatedSavingsUsd >= 100) {
        // Surface as a notification + a concierge chat message, but only for
        // the trip owner (so we don't pester the whole group with each scan).
        const owner = await db.tripMember.findFirst({
          where: { tripId, role: "OWNER" },
        });
        if (owner?.userId) {
          await db.notification.create({
            data: {
              tripId,
              userId: owner.userId,
              type: "SYSTEM",
              title: `Possible savings: ~$${result.estimatedSavingsUsd}`,
              message: result.proposal,
            },
          });
        }
        await db.chatMessage.create({
          data: {
            tripId,
            role: "ASSISTANT",
            content: `Possible savings — about $${result.estimatedSavingsUsd}: ${result.proposal}`,
            metadata: { kind: "cost_watchdog", itemId: result.itemId ?? null },
          },
        });
        nudge(tripId);
      }
      return result;
    },
  });
}
