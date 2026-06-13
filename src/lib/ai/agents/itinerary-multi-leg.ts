/**
 * Multi-leg itinerary builder — runs the itinerary agent ONCE PER LEG in
 * parallel, then merges the results.
 *
 * Why: the single-pass itinerary agent struggles past ~3 destinations × 4
 * days each. The output is too big for the AI to keep coherent in one
 * structured emit, and the request can blow past the 8-minute client timeout
 * waiting for a 100-item JSON tool call. Per-leg parallelism keeps each call
 * small + fast (~30-60s instead of 2-3 min), and total wall-clock is roughly
 * the slowest leg, not the sum.
 *
 * Failure semantics: `Promise.allSettled` — if ONE leg fails (truncation,
 * Anthropic error, etc.), the others still land. A partial itinerary beats
 * a total failure, and the user gets a clear "couldn't plan leg X — refine
 * and retry" message.
 *
 * Pure ground-level builder. The caller (build/route.ts) handles flights
 * (Duffel) separately keyed off the leg sequence, so each per-leg agent is
 * instructed to skip FLIGHT items entirely.
 */

import { runItineraryAgent } from "./itinerary";
import { optionalEnv } from "@/lib/env";
import type { ItineraryAI, ItineraryItemAI, TripConstraints } from "../schemas";
import type { LegWithDates } from "@/lib/quiz/parse-legs";

export type MultiLegResult = {
  /** Merged itinerary across all legs (no FLIGHT items — caller handles those). */
  itinerary: ItineraryAI;
  /** Per-leg outcomes — for partial-success messaging. */
  legs: Array<{
    index: number;
    destination: string;
    status: "ok" | "failed";
    error?: string;
  }>;
};

/**
 * Max legs planned at once. Firing ALL legs in parallel hammers the Anthropic
 * rate limit on low-tier accounts → the SDK silently backs off + retries (5×
 * by default) → a "4-place" trip takes 15+ minutes. Capping concurrency at 2
 * keeps us under the per-minute token limit, so on a tier-1 account this is
 * actually FASTER than all-at-once. Bump via MULTI_LEG_CONCURRENCY once on a
 * higher API tier.
 */
const DEFAULT_CONCURRENCY = 4;

/** Hard ceiling per leg. A single stuck Opus call (truncation-retry loop,
 *  overload backoff) can't hang the whole build past this — it just fails
 *  that leg and the others still land. */
const PER_LEG_TIMEOUT_MS = 150_000;

/**
 * Plan every leg in parallel + merge. Throws ONLY if ALL legs fail; any
 * partial success returns a valid (smaller) itinerary.
 */
export async function buildMultiLegItinerary(args: {
  tripId: string;
  constraints: TripConstraints;
  legs: LegWithDates[];
}): Promise<MultiLegResult> {
  const concurrency = Math.max(
    1,
    Number(optionalEnv("MULTI_LEG_CONCURRENCY")) || DEFAULT_CONCURRENCY,
  );

  // Concurrency-limited fan-out. Each leg is wrapped in a hard timeout so a
  // single stuck call can never hang the whole build.
  const settled = await mapWithConcurrency(
    args.legs,
    concurrency,
    (leg, idx) =>
      withTimeout(
        runItineraryAgent({
          tripId: args.tripId,
          destination: leg.destination,
          constraints: buildLegConstraints(args.constraints, args.legs, leg, idx),
          priorItinerary: null,
        }),
        PER_LEG_TIMEOUT_MS,
        `Leg "${leg.destination}" timed out after ${Math.round(PER_LEG_TIMEOUT_MS / 1000)}s`,
      ),
  );

  const perLeg: MultiLegResult["legs"] = [];
  const mergedItems: ItineraryItemAI[] = [];
  const summaryLines: string[] = [];
  let totalCost = 0;
  let perPersonCost = 0;
  let groupSize = 1;

  for (let i = 0; i < settled.length; i++) {
    const leg = args.legs[i];
    const result = settled[i];
    if (result.status !== "fulfilled") {
      const err =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.warn(
        `[multi-leg] leg ${i} (${leg.destination}) failed: ${err.slice(0, 200)}`,
      );
      perLeg.push({
        index: i,
        destination: leg.destination,
        status: "failed",
        error: err,
      });
      continue;
    }
    const out = result.value.output;
    perLeg.push({ index: i, destination: leg.destination, status: "ok" });

    // Strip any FLIGHT items the leg agent might have emitted despite the
    // instruction — those are owned by the trip-level Duffel search, not the
    // per-leg builder. Tag everything else with legIndex so the UI can group.
    for (const item of out.items) {
      if (item.type === "FLIGHT") continue;
      const existingMeta =
        (item.metadata as Record<string, unknown> | null) ?? {};
      mergedItems.push({
        ...item,
        metadata: { ...existingMeta, legIndex: i } as Record<string, unknown>,
      });
    }

    if (out.summary) summaryLines.push(`**${leg.destination}** — ${out.summary}`);
    totalCost += out.totalCost ?? 0;
    perPersonCost += out.perPersonCost ?? 0;
    // Infer group size from any leg's ratio (they should agree).
    if (out.totalCost > 0 && out.perPersonCost > 0) {
      groupSize = Math.max(1, Math.round(out.totalCost / out.perPersonCost));
    }
  }

  // LODGING GUARANTEE: a leg can come back "ok" yet hotel-less (a real
  // Capri/Venice trip shipped with no Venice hotel — the customer had
  // nowhere to sleep on leg 2). For each ok leg with no LODGING item,
  // retry that single leg ONCE with an explicit corrective note; if the
  // retry still has no hotel, downgrade the leg to failed so the partial-
  // failure banner tells the customer instead of shipping a broken trip.
  for (const legRes of perLeg) {
    if (legRes.status !== "ok") continue;
    const i = legRes.index;
    const hasLodging = mergedItems.some(
      (it) =>
        it.type === "LODGING" &&
        (it.metadata as { legIndex?: number } | null)?.legIndex === i,
    );
    if (hasLodging) continue;
    const leg = args.legs[i];
    console.warn(
      `[multi-leg] ✗ leg ${i} (${leg.destination}) returned NO lodging — retrying that leg once.`,
    );
    try {
      const retryConstraints = buildLegConstraints(
        args.constraints,
        args.legs,
        leg,
        i,
      );
      retryConstraints.notes = `YOUR PREVIOUS ATTEMPT OMITTED THE HOTEL — INVALID. This output MUST contain exactly ONE LODGING item in ${leg.destination} for the leg's full date range. ${retryConstraints.notes ?? ""}`;
      const retry = await withTimeout(
        runItineraryAgent({
          tripId: args.tripId,
          destination: leg.destination,
          constraints: retryConstraints,
          priorItinerary: null,
        }),
        PER_LEG_TIMEOUT_MS,
        `Leg "${leg.destination}" lodging retry timed out`,
      );
      const retryItems = retry.output.items.filter((it) => it.type !== "FLIGHT");
      const retryHasLodging = retryItems.some((it) => it.type === "LODGING");
      if (retryHasLodging) {
        // Replace the leg's items wholesale with the corrected set.
        for (let k = mergedItems.length - 1; k >= 0; k--) {
          const li = (mergedItems[k].metadata as { legIndex?: number } | null)
            ?.legIndex;
          if (li === i) mergedItems.splice(k, 1);
        }
        for (const item of retryItems) {
          const existingMeta =
            (item.metadata as Record<string, unknown> | null) ?? {};
          mergedItems.push({
            ...item,
            metadata: { ...existingMeta, legIndex: i } as Record<string, unknown>,
          });
        }
        console.log(
          `[multi-leg] ✓ leg ${i} (${leg.destination}) lodging repaired on retry.`,
        );
      } else {
        legRes.status = "failed";
        legRes.error = `Planned ${leg.destination} but couldn't pick a hotel — retry the build or set one manually.`;
        console.warn(
          `[multi-leg] ✗ leg ${i} (${leg.destination}) STILL no lodging after retry — flagged as failed.`,
        );
      }
    } catch (e) {
      legRes.status = "failed";
      legRes.error = `Lodging repair for ${leg.destination} failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  const successCount = perLeg.filter((l) => l.status === "ok").length;
  if (successCount === 0) {
    const firstErr = perLeg.find((l) => l.error)?.error ?? "all legs failed";
    throw new Error(`Multi-leg build failed for every leg: ${firstErr}`);
  }

  // Synthesize the flight BOOKENDS so the Flights section always appears,
  // even before (or without) a live Duffel search. The per-leg agents are
  // told NOT to emit flights, so without this a multi-leg trip would show
  // ZERO flights (the bug Carson hit). The trip pipeline's Duffel pre-search
  // still runs separately and enriches these with real "pick your flight"
  // fares when an origin airport is set. Inter-leg movement is left to each
  // leg's ground transport (a drive/train between nearby stops — correct for
  // e.g. two Florida resorts).
  const firstLeg = args.legs[0];
  const lastLeg = args.legs[args.legs.length - 1];
  const outbound: ItineraryItemAI = {
    type: "FLIGHT",
    title: `Flight to ${firstLeg.destination}`,
    description:
      "Outbound flight. Live business-class fares are pulled from Duffel once your home airport is set — pick your exact flight on the trip page.",
    location: null,
    address: null,
    startTime: firstLeg.startDate ? `${firstLeg.startDate}T08:00:00` : null,
    endTime: null,
    cost: null,
    aiRationale: null,
    metadata: { legIndex: 0, segment: "outbound" } as Record<string, unknown>,
  };
  const returnFlight: ItineraryItemAI = {
    type: "FLIGHT",
    title: `Return flight home from ${lastLeg.destination}`,
    description:
      "Return flight. Live fares pulled from Duffel once your home airport is set.",
    location: null,
    address: null,
    startTime: lastLeg.endDate ? `${lastLeg.endDate}T17:00:00` : null,
    endTime: null,
    cost: null,
    aiRationale: null,
    metadata: {
      legIndex: args.legs.length - 1,
      segment: "return",
    } as Record<string, unknown>,
  };
  mergedItems.push(outbound, returnFlight);

  // Sort items by leg, then by startTime within a leg — so the UI's
  // chronological groupings stay consistent.
  mergedItems.sort((a, b) => {
    const ai = (a.metadata as { legIndex?: number } | null)?.legIndex ?? 999;
    const bi = (b.metadata as { legIndex?: number } | null)?.legIndex ?? 999;
    if (ai !== bi) return ai - bi;
    const at = a.startTime ? Date.parse(a.startTime) : Number.MAX_SAFE_INTEGER;
    const bt = b.startTime ? Date.parse(b.startTime) : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  const itinerary: ItineraryAI = {
    summary: summaryLines.join("\n\n"),
    totalCost,
    perPersonCost: Math.max(perPersonCost, Math.round(totalCost / Math.max(groupSize, 1))),
    items: mergedItems.length > 0 ? mergedItems : ([] as unknown as ItineraryItemAI[]),
    changes: [],
  };

  return { itinerary, legs: perLeg };
}

/**
 * Build the constraints we pass to a SINGLE-leg agent call. Narrows the
 * trip-level constraints down to this leg's window + tells the agent to
 * focus only on this destination and skip flights (the trip handles those).
 */
function buildLegConstraints(
  base: TripConstraints,
  allLegs: LegWithDates[],
  leg: LegWithDates,
  legIndex: number,
): TripConstraints {
  // Split the trip budget across legs by their share of total nights, so
  // each leg targets ITS portion (not the whole budget — which made every
  // leg either lowball or, worse, each try to spend the full amount). The
  // summed legs then land near the real trip budget. Flights are excluded
  // from per-leg budgets (the trip pipeline handles them), so reserve a
  // slice for flights by only allocating ~85% of the budget across legs.
  const nightsOf = (l: LegWithDates) => {
    if (!l.startDate || !l.endDate) return 1;
    const ms = Date.parse(l.endDate) - Date.parse(l.startDate);
    return Math.max(1, Math.round(ms / 86_400_000));
  };
  const totalNights = allLegs.reduce((s, l) => s + nightsOf(l), 0);
  const legShare = nightsOf(leg) / Math.max(totalNights, 1);
  const groundBudgetFraction = 0.85; // leave ~15% headroom for flights
  const splitBudget = (v: number | null | undefined): number | null =>
    typeof v === "number" && v > 0
      ? Math.round(v * groundBudgetFraction * legShare)
      : null;

  const legBudgetTotal = splitBudget(base.budgetTotal);
  const legBudgetPerPerson = splitBudget(base.budgetPerPerson);

  const note = [
    `THIS IS LEG ${legIndex + 1} OF ${allLegs.length} (zero-based legIndex=${legIndex}) — focus ONLY on ${leg.destination}.`,
    `Other destinations on this trip are planned by separate agent calls and will be merged. Do NOT plan items for them.`,
    `Do NOT emit any FLIGHT items — the trip pipeline books all flights separately based on the leg airports.`,
    `Plan lodging, golf, dining, ground transport, activities, and free time for this destination only.`,
    `LODGING IS MANDATORY: your output MUST include exactly ONE LODGING item in ${leg.destination} covering ALL of this leg's nights (check-in = leg start date, check-out = leg end date). An itinerary leg without a hotel strands the customer with nowhere to sleep (a real Capri/Venice trip shipped with no Venice hotel) — it is INVALID output.`,
    `Ground transport: only emit Uber/transfer items for the ESSENTIAL transfers — airport↔hotel, and hotel↔course ONLY when the course is OFF the lodging property (a separate venue a real drive away). If the course is ON the resort grounds / same resort as the lodging (e.g. Pinehurst, Pebble, Bandon, Streamsong, Kiawah resort courses), emit NO transport item — guests walk or take the free resort shuttle. Do NOT add Ubers for dinners, bars, activities, or sightseeing; guests summon those in-app themselves in the moment.`,
    legBudgetTotal
      ? `This leg's budget is about $${legBudgetTotal.toLocaleString()} total (your share of the trip across ${allLegs.length} stops). SPEND IT — pick the top lodging tier + best options this leg's share supports; don't come in far under.`
      : "",
    `Tag every item with metadata.legIndex=${legIndex}.`,
    base.notes ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...base,
    destination: leg.destination,
    startDate: leg.startDate,
    endDate: leg.endDate,
    budgetTotal: legBudgetTotal,
    budgetPerPerson: legBudgetPerPerson,
    notes: note,
  };
}

/* -------------------------------------------------------------------------- */
/* Concurrency + timeout helpers                                               */
/* -------------------------------------------------------------------------- */

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving
 * order in the returned settled array. (No p-map dependency — a tiny worker
 * pool does the job.)
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(pool);
  return results;
}

/** Reject if `p` doesn't settle within `ms`. The underlying agent call keeps
 *  running but its result is discarded — acceptable, the leg is marked failed. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
