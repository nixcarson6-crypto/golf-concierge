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
 * Plan every leg in parallel + merge. Throws ONLY if ALL legs fail; any
 * partial success returns a valid (smaller) itinerary.
 */
export async function buildMultiLegItinerary(args: {
  tripId: string;
  constraints: TripConstraints;
  legs: LegWithDates[];
}): Promise<MultiLegResult> {
  const settled = await Promise.allSettled(
    args.legs.map((leg, idx) =>
      runItineraryAgent({
        tripId: args.tripId,
        destination: leg.destination,
        constraints: buildLegConstraints(args.constraints, args.legs, leg, idx),
        priorItinerary: null,
      }),
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

  const successCount = perLeg.filter((l) => l.status === "ok").length;
  if (successCount === 0) {
    const firstErr = perLeg.find((l) => l.error)?.error ?? "all legs failed";
    throw new Error(`Multi-leg build failed for every leg: ${firstErr}`);
  }

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
  const note = [
    `THIS IS LEG ${legIndex + 1} OF ${allLegs.length} (zero-based legIndex=${legIndex}) — focus ONLY on ${leg.destination}.`,
    `Other destinations on this trip are planned by separate agent calls and will be merged. Do NOT plan items for them.`,
    `Do NOT emit any FLIGHT items — the trip pipeline books all flights separately based on the leg airports.`,
    `Plan lodging, golf, dining, ground transport (Uber/transfers), activities, and free time for this destination only.`,
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
    notes: note,
  };
}
