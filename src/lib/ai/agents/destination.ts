import { runStructured, withAgentRun } from "../orchestrator";
import { DESTINATION_SYSTEM } from "../prompts";
import {
  destinationListSchema,
  type DestinationListAI,
  type TripConstraints,
} from "../schemas";
import { unsplashUrlFor } from "@/lib/data/imagery";

export type DestinationAgentInput = {
  tripId: string;
  constraints: TripConstraints;
};

export async function runDestinationAgent(input: DestinationAgentInput) {
  return withAgentRun({
    tripId: input.tripId,
    agentType: "DESTINATION",
    input: input.constraints as Record<string, unknown>,
    progress: "Comparing premium golf markets…",
    fn: async () => {
      const raw: DestinationListAI = await runStructured({
        tier: "orchestrator",
        system: DESTINATION_SYSTEM,
        schema: destinationListSchema,
        toolName: "emit_destinations",
        toolDescription: "Emit 3 ranked destination recommendations.",
        messages: [
          {
            role: "user",
            content: `Group constraints:\n${JSON.stringify(
              input.constraints,
              null,
              2,
            )}\n\nPropose 3 destinations now.`,
          },
        ],
        maxTokens: 3000,
        temperature: 0.55,
      });

      // Decorate each option with a hero image URL derived from the AI query.
      // Unsplash 'source' URLs don't require a key and are stable enough
      // for MVP; swap to the Unsplash API + caching pre-launch.
      const enriched = raw.options.map((opt, i) => ({
        ...opt,
        heroImageUrl: unsplashUrlFor(opt.heroImageQuery),
        rank: i,
      }));

      return { ...raw, options: enriched };
    },
  });
}
