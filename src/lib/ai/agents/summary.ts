import { runStructured, withAgentRun } from "../orchestrator";
import { SUMMARY_SYSTEM } from "../prompts";
import { summarySchema, type SummaryAI } from "../schemas";

export type SummaryAgentInput = {
  tripId: string;
  context: {
    title: string;
    destination: string | null;
    startDate: string | null;
    endDate: string | null;
    groupSize: number | null;
    totalCost: number | null;
    perPersonCost: number | null;
    items: Array<{
      type: string;
      title: string;
      startTime?: string | null;
      cost?: number | null;
      status?: string | null;
      confirmationCode?: string | null;
    }>;
    substitutions: string[];
  };
};

export async function runSummaryAgent(input: SummaryAgentInput): Promise<SummaryAI> {
  const { output } = await withAgentRun({
    tripId: input.tripId,
    agentType: "SUMMARY",
    input: { context: input.context as Record<string, unknown> },
    progress: "Compiling the final trip summary…",
    fn: async () =>
      runStructured({
        tier: "orchestrator",
        system: SUMMARY_SYSTEM,
        schema: summarySchema,
        toolName: "emit_summary",
        toolDescription: "Emit the trip summary.",
        messages: [
          {
            role: "user",
            content: `Final trip data:\n${JSON.stringify(input.context, null, 2)}\n\nWrite the summary now.`,
          },
        ],
        maxTokens: 2000,
        temperature: 0.5,
      }),
  });
  return output;
}
