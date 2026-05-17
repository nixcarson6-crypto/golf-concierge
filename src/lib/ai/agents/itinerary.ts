import { runStructured, withAgentRun } from "../orchestrator";
import { ITINERARY_SYSTEM } from "../prompts";
import {
  itinerarySchema,
  type ItineraryAI,
  type TripConstraints,
} from "../schemas";
import {
  destinationBriefForAI,
  findDestination,
} from "@/lib/data/destinations";

export type ItineraryAgentInput = {
  tripId: string;
  destination: string;
  constraints: TripConstraints;
  /** Optional: prior itinerary serialised, when we're re-optimizing. */
  priorItinerary?: ItineraryAI | null;
  /** Free-form instruction for refinements, e.g. "swap the steakhouse for sushi" */
  refinementInstruction?: string;
};

export async function runItineraryAgent(input: ItineraryAgentInput) {
  const isRefine = Boolean(input.priorItinerary || input.refinementInstruction);
  return withAgentRun({
    tripId: input.tripId,
    agentType: "ITINERARY",
    input: {
      destination: input.destination,
      constraints: input.constraints as Record<string, unknown>,
      refinement: input.refinementInstruction ?? null,
      hasPrior: Boolean(input.priorItinerary),
    },
    progress: isRefine
      ? "Re-tuning your itinerary…"
      : "Drafting the itinerary…",
    fn: async () => {
      const kb = findDestination(input.destination);
      const brief = kb ? destinationBriefForAI(kb) : null;
      const briefSection = brief
        ? `DESTINATION_BRIEF (authoritative — use these real venues):\n${JSON.stringify(brief, null, 2)}\n\n`
        : `(No curated brief for "${input.destination}" — draw on what you know about this market and admit uncertainty.)\n\n`;

      const userMessage = isRefine
        ? `${briefSection}Constraints:\n${JSON.stringify(
            input.constraints,
            null,
            2,
          )}\n\nPrior itinerary (JSON; respect locked items):\n${JSON.stringify(
            input.priorItinerary,
            null,
            2,
          )}\n\nRefinement instruction:\n${input.refinementInstruction ?? "(none — adapt to updated constraints)"}\n\nProduce the new full itinerary now. List substitutions in 'changes'.`
        : `${briefSection}Constraints:\n${JSON.stringify(
            input.constraints,
            null,
            2,
          )}\n\nDraft the full itinerary now.`;

      const result = await runStructured({
        tier: "orchestrator",
        system: ITINERARY_SYSTEM,
        cacheSystem: true,
        schema: itinerarySchema,
        toolName: "emit_itinerary",
        toolDescription: "Emit the full itinerary as structured data.",
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 6000,
        temperature: 0.55,
        thinking: { enabled: true, budgetTokens: 4000 },
      });
      return result;
    },
  });
}
