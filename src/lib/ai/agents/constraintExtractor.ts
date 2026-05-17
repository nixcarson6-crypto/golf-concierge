import { runStructured, type AgentMessage, withAgentRun } from "../orchestrator";
import { CONSTRAINT_EXTRACTOR_SYSTEM } from "../prompts";
import { extractionResponseSchema, type ExtractionResponse, type TripConstraints } from "../schemas";

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

      const seed: AgentMessage[] = [
        {
          role: "user",
          content: `Current known constraints (JSON):\n${JSON.stringify(
            input.current,
            null,
            2,
          )}\n\nUpdate them based on the conversation that follows. If a field has no signal, return null for it.`,
        },
        { role: "assistant", content: "Understood. Continuing the conversation." },
        ...recent,
      ];

      const result: ExtractionResponse = await runStructured({
        tier: "orchestrator",
        system: CONSTRAINT_EXTRACTOR_SYSTEM,
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
