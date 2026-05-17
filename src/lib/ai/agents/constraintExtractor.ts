import { runStructured, type AgentMessage, withAgentRun } from "../orchestrator";
import { CONSTRAINT_EXTRACTOR_SYSTEM } from "../prompts";
import { extractionResponseSchema, type ExtractionResponse, type TripConstraints } from "../schemas";
import { DESTINATIONS } from "@/lib/data/destinations";

export type ConstraintExtractorInput = {
  tripId: string;
  /** Latest constraints we already know about the trip. */
  current: TripConstraints;
  /** Recent chat turns including the new user message at the end. */
  messages: AgentMessage[];
};

const CONTEXT_TURNS = 12;

export async function runConstraintExtractor(input: ConstraintExtractorInput) {
  return withAgentRun({
    tripId: input.tripId,
    agentType: "CONSTRAINT_EXTRACTOR",
    input: { current: input.current as Record<string, unknown> },
    progress: "Listening…",
    fn: async () => {
      const recent = input.messages.slice(-CONTEXT_TURNS);

      const marketCues = DESTINATIONS.map(
        (d) => `- ${d.name} (slug: ${d.slug}) — golf ${d.golfScore}, nightlife ${d.nightlifeScore}, logistics ${d.logisticsScore}`,
      ).join("\n");

      const seed: AgentMessage[] = [
        {
          role: "user",
          content: [
            `MARKETS YOU CAN CONFIDENTLY PLAN (have full curated knowledge for):`,
            marketCues,
            `For any other destination, you can still plan but should signal uncertainty.`,
            ``,
            `Current known constraints (JSON):`,
            JSON.stringify(input.current, null, 2),
            ``,
            `Update them based on the conversation that follows. If a field has no signal, return null for it.`,
          ].join("\n"),
        },
        { role: "assistant", content: "Understood. Continuing the conversation." },
        ...recent,
      ];

      const result: ExtractionResponse = await runStructured({
        tier: "orchestrator",
        system: CONSTRAINT_EXTRACTOR_SYSTEM,
        cacheSystem: true,
        schema: extractionResponseSchema,
        toolName: "update_trip_state",
        toolDescription:
          "Echo back ALL known constraints, the concierge reply, any follow-up questions, and whether you're ready to plan.",
        messages: seed,
        maxTokens: 2048,
        temperature: 0.4,
      });

      return result;
    },
  });
}
