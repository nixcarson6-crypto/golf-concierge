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
  /**
   * True only for an OPEN-ENDED "Surprise me" (no place hint at all). When
   * set, we inject a server-randomized shortlist of excellent markets and
   * push the #1 off the reflex defaults. The model is stateless and can't
   * "rotate its #1 run-to-run" on its own, so the variety has to come from
   * the server — this flag is what supplies it.
   */
  variety?: boolean;
  /** Destinations the customer was recently shown — never return these again. */
  avoidDestinations?: string[];
};

/**
 * Excellent, publicly-bookable golf markets to rotate the open-ended
 * "Surprise me" #1 across. DELIBERATELY omits the three reflex defaults
 * (Bandon Dunes, Pinehurst, Pebble Beach) so the server-side seed never
 * re-suggests the exact market the customer is tired of seeing. The model
 * may still land on one of those if the customer's OWN answers demand it,
 * but it is never the lazy default.
 */
const VARIETY_POOL: string[] = [
  "Scottsdale, AZ",
  "Streamsong, FL",
  "Sea Island, GA",
  "Kiawah Island, SC",
  "Whistling Straits / Kohler, WI",
  "Sand Valley, WI",
  "Cabot Cape Breton, Nova Scotia",
  "Hilton Head Island, SC",
  "Reynolds Lake Oconee, GA",
  "The Greenbrier, WV",
  "Cabo San Lucas, Mexico",
  "Palm Springs / PGA West, CA",
  "Forest Dunes, MI",
  "Arcadia Bluffs, MI",
  "French Lick, IN",
  "Big Cedar Lodge, MO",
  "Kapalua, Maui",
  "Naples, FL",
  "Las Vegas, NV",
  "Cabot Citrus Farms, FL",
  "Pursell Farms, AL",
  "Erin Hills, WI",
];

const leadName = (s: string): string => s.toLowerCase().split(",")[0].trim();

/** Fisher–Yates shuffle of the pool minus anything recently shown, take n. */
function pickVarietyShortlist(avoid: string[], n = 6): string[] {
  const avoidLeads = new Set(avoid.map(leadName).filter(Boolean));
  const eligible = VARIETY_POOL.filter((m) => !avoidLeads.has(leadName(m)));
  const arr = eligible.length >= n ? [...eligible] : [...VARIETY_POOL];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/** The server-randomized variety block injected into the agent's prompt. */
function buildVarietyDirective(avoid: string[]): string {
  const shortlist = pickVarietyShortlist(avoid);
  const avoidLine = avoid.length
    ? `\nThe customer was RECENTLY shown these — do NOT return ANY of them again: ${avoid.join(", ")}.`
    : "";
  return [
    `VARIETY SHORTLIST (server-randomized for THIS run — the customer chose "Surprise me" with no specific place in mind):`,
    shortlist.map((m) => `  • ${m}`).join("\n"),
    `Pick your #1 from THIS shortlist — whichever best fits the customer's travel month and any course-style / region / vibe answers they gave. Options 2 and 3 may be off-list, but all three must be genuinely DISTINCT from each other. Do NOT lead with Bandon Dunes, Pinehurst, or Pebble Beach unless the customer's OWN answers explicitly demand that exact style — those are the reflex defaults, and the whole point of "Surprise me" is a fresh, hand-picked place they wouldn't have guessed.${avoidLine}`,
  ].join("\n");
}

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
          // Opus 4.7. Carson's call: quality over cost, no compromise.
          // Destination choice sets the whole tone of the trip, so it
          // gets the strongest model even though a cheaper one could
          // do the raw ranking.
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
                ...(input.variety
                  ? [``, buildVarietyDirective(input.avoidDestinations ?? [])]
                  : []),
                ``,
                `Propose 3 destinations now, ranked, strongest fit first.`,
              ].join("\n"),
            },
          ],
          maxTokens: 4000,
          // The model is STATELESS — it can't "rotate its #1 run-to-run" on
          // its own (no memory of past picks), so on an open-ended "Surprise
          // me" it always lands on the highest-base-score market (Bandon
          // Dunes, golfScore 99). The server-randomized variety shortlist
          // injected above is what actually forces rotation; a higher
          // temperature just adds spread among the equally-good fits.
          temperature: input.variety ? 0.9 : 0.8,
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

      // DETERMINISTIC reflex-default guard (open-ended "Surprise me" only).
      // The model is stateless and score-driven, so even with the variety
      // shortlist it sometimes still leads with the highest-base-score market
      // (Bandon Dunes), which is exactly the "why does it ALWAYS go to Bandon?"
      // problem. On a variety run we NEVER want a reflex default as #1 — the
      // customer asked to be surprised. If the model led with one, promote the
      // first genuinely different option. (Hinted runs are left alone: Pinehurst
      // for a "North Carolina" hint is the RIGHT answer, not a lazy default.)
      if (input.variety && raw.options.length > 1) {
        const REFLEX = ["bandon", "pinehurst", "pebble beach"];
        const isReflex = (name: string) =>
          REFLEX.some((r) => name.toLowerCase().includes(r));
        if (isReflex(raw.options[0]?.name ?? "")) {
          const altIdx = raw.options.findIndex(
            (o, i) => i > 0 && !isReflex(o.name),
          );
          if (altIdx > 0) {
            const [alt] = raw.options.splice(altIdx, 1);
            const dropped = raw.options[0]?.name;
            raw.options.unshift(alt);
            console.log(
              `[destination] reflex-default guard: led with "${dropped}" on a Surprise-me run — promoted "${alt.name}" instead.`,
            );
          }
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
