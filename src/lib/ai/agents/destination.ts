import { runStructured, withAgentRun } from "../orchestrator";
import { DESTINATION_SYSTEM } from "../prompts";
import {
  destinationListSchema,
  type DestinationListAI,
  type TripConstraints,
} from "../schemas";
import { unsplashUrlFor } from "@/lib/data/imagery";
import { allDestinationsBriefForAI, monthFromDate } from "@/lib/data/destinations";

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
      const kb = allDestinationsBriefForAI();
      const month =
        monthFromDate(input.constraints.startDate) ??
        monthFromDate(input.constraints.endDate);

      const raw: DestinationListAI = await runStructured({
        tier: "orchestrator",
        system: DESTINATION_SYSTEM,
        cacheSystem: true,
        schema: destinationListSchema,
        toolName: "emit_destinations",
        toolDescription: "Emit 3 ranked destination recommendations.",
        messages: [
          {
            role: "user",
            content: [
              `KNOWLEDGE_BASE (authoritative for these markets):`,
              JSON.stringify(kb, null, 2),
              ``,
              `Travel month signal: ${month ?? "unknown"} — consult the weather table for each candidate.`,
              ``,
              `Group constraints:`,
              JSON.stringify(input.constraints, null, 2),
              ``,
              `Propose 3 destinations now, ranked, strongest fit first.`,
            ].join("\n"),
          },
        ],
        maxTokens: 4000,
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
