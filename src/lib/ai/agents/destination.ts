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

      // Mirror the itinerary agent's retry: model glitches (truncation,
      // empty tool_use, overloaded 529, rate-limit 429, transient
      // schema validation failures) are common at scale and ALWAYS
      // succeed on a retry. Without this, a single 529 on the
      // destination step bounces the customer to the "We couldn't
      // finish your itinerary" page even though one second later the
      // model would have responded fine.
      const runOnce = (): Promise<DestinationListAI> =>
        runStructured({
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
      const isRetryable = (msg: string): boolean =>
        msg.includes("truncated at max_tokens") ||
        msg.includes("schema validation failed") ||
        msg.includes("did not return a tool_use") ||
        msg.includes("overloaded") ||
        msg.includes("rate_limit") ||
        msg.includes("Internal server error") ||
        msg.includes("ECONNRESET") ||
        msg.includes("fetch failed");
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let raw: DestinationListAI;
      try {
        raw = await runOnce();
      } catch (err1) {
        const m1 = err1 instanceof Error ? err1.message : String(err1);
        if (!isRetryable(m1)) throw err1;
        console.warn(
          `[destination] attempt 1 failed (${m1.slice(0, 140)}…) — retrying after 2s`,
        );
        await sleep(2_000);
        try {
          raw = await runOnce();
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          if (!isRetryable(m2)) throw err2;
          console.warn(
            `[destination] attempt 2 failed (${m2.slice(0, 140)}…) — final retry after 5s`,
          );
          await sleep(5_000);
          raw = await runOnce();
        }
      }

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
