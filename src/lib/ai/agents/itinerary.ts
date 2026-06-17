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
import { db } from "@/lib/db";
import {
  searchGolfCoursesNear,
  formatCoursesForPrompt,
} from "@/lib/places/golf-search";

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

      // Pull any per-member preferences captured by the member-preferences
      // agent so the itinerary can personalise (e.g. dietary, handicap,
      // nightlife appetite per person).
      const members = await db.tripMember.findMany({
        where: { tripId: input.tripId },
        include: { memberPreferences: true },
      });
      const memberPrefs = members
        .filter((m) => m.memberPreferences)
        .map((m) => ({
          name: m.name ?? m.email,
          prefs: m.memberPreferences!.data,
        }));
      const memberSection = memberPrefs.length
        ? `MEMBER_PREFERENCES (use to personalise — call out picks tailored to specific members in aiRationale where relevant):\n${JSON.stringify(memberPrefs, null, 2)}\n\n`
        : "";

      // Conversation context — keep the rolling summary if present so the
      // itinerary respects nuances from earlier turns without re-reading the
      // whole transcript.
      const convo = await db.conversationSummary.findUnique({
        where: { tripId: input.tripId },
      });
      const convoSection = convo?.content
        ? `CONVERSATION_CONTEXT (from earlier turns):\n${convo.content}\n\n`
        : "";

      // LIVE nearby-course search — REAL golf courses near this destination
      // (Google ratings + addresses), so the AI picks the best LOCAL course
      // instead of relying on memory. This is the fix for it once sending a
      // Taormina guest 3.5 hrs to Verdura while missing Il Picciolo 40 min
      // away. Best-effort: empty section if the search returns nothing.
      const nearbyCourses = await searchGolfCoursesNear(input.destination);
      const courseSection = nearbyCourses.length
        ? `NEARBY_COURSES (LIVE Google search near "${input.destination}" — REAL courses that exist here, listed best-review-first with Google ratings. Use this for COVERAGE so you never miss a nearby course, and as a STRONG supporting signal. But judge course QUALITY like a luxury golf concierge: weigh golf PEDIGREE first (championship caliber / Top-100 ranking / notable designer / tournament history — use what you know), with the Google rating + proximity as strong support. Do NOT auto-pick purely by stars — reviews measure "nice day out", not "best golf", so a casual course can out-review a masterpiece. Among courses genuinely CLOSE to the lodging, pick the best by pedigree; use the rating to break ties or surface a hidden gem. Never haul the guest to a famous course far away when a comparable one is nearby):\n${formatCoursesForPrompt(nearbyCourses)}\n\n`
        : "";

      const userMessage = isRefine
        ? `${briefSection}${courseSection}${memberSection}${convoSection}Constraints:\n${JSON.stringify(
            input.constraints,
            null,
            2,
          )}\n\nPrior itinerary (JSON; respect locked items):\n${JSON.stringify(
            input.priorItinerary,
            null,
            2,
          )}\n\nRefinement instruction:\n${input.refinementInstruction ?? "(none — adapt to updated constraints)"}\n\nProduce the new full itinerary now. List substitutions in 'changes'.`
        : `${briefSection}${courseSection}${memberSection}${convoSection}Constraints:\n${JSON.stringify(
            input.constraints,
            null,
            2,
          )}\n\nDraft the full itinerary now.`;

      // Token budget: a 4-day single-destination trip is ~3-4k tokens.
      // A 10-day multi-leg trip with 5-6 items per day approaches 10k+.
      // Default to a generous budget; if the model still truncates,
      // we retry once at 24k before giving up. Opus 4.7's max is well
      // above this so there's headroom for genuinely complex requests.
      const runOnce = (maxTokens: number) =>
        runStructured({
          tier: "orchestrator",
          system: ITINERARY_SYSTEM,
          cacheSystem: true,
          schema: itinerarySchema,
          toolName: "emit_itinerary",
          toolDescription: "Emit the full itinerary as structured data.",
          messages: [{ role: "user", content: userMessage }],
          maxTokens,
        });

      /**
       * Patterns that mean the model dropped the ball in a way a retry can
       * fix. The orchestrator throws these as labelled strings — we match
       * them and try again instead of bouncing the customer with a Zod dump.
       * NOTE: we deliberately do NOT agent-level-retry on overload / rate_limit
       * / 5xx — the SDK already retries those transient errors internally, and
       * firing a SECOND full Opus call (at 24k tokens, no less) when Opus is
       * already overloaded just doubles the hang. Those now fail fast.
       */
      const isRetryableModelGlitch = (msg: string): boolean =>
        msg.includes("truncated at max_tokens") ||
        msg.includes("schema validation failed") || // empty tool_use input
        msg.includes("did not return a tool_use"); // refusal / null response

      // Up to THREE attempts. First at 14k. On any retryable glitch, retry
      // at 24k (handles truncation AND incidentally gives a glitched model
      // more headroom). On a second glitch, one final attempt with a brief
      // pause to ride out any transient overload.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        return await runOnce(14_000);
      } catch (err1) {
        const m1 = err1 instanceof Error ? err1.message : String(err1);
        if (!isRetryableModelGlitch(m1)) throw err1;
        console.warn(
          `[itinerary] attempt 1 failed (${m1.slice(0, 140)}…) — retrying at 24k`,
        );
        try {
          return await runOnce(24_000);
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          if (!isRetryableModelGlitch(m2)) throw err2;
          console.warn(
            `[itinerary] attempt 2 failed (${m2.slice(0, 140)}…) — sleeping 4s then final retry`,
          );
          await sleep(4_000);
          return await runOnce(24_000);
        }
      }
    },
  });
}
