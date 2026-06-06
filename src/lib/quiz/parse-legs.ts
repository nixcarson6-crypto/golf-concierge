/**
 * Multi-leg destination parser. Takes a freeform user input and an
 * optional trip date range, returns a structured list of legs.
 *
 * Handles common patterns:
 *   "Pinehurst for 5 days then Broadmoor for 4"
 *   "Bandon Dunes for 3 nights and then Pebble Beach for 4 nights"
 *   "Pinehurst then Broadmoor"  (no day counts → split dates evenly)
 *   "Pinehurst"                 (single-leg → returns one leg)
 *
 * Returns null if the input doesn't look multi-leg, so callers can
 * fall back to single-destination handling.
 *
 * Falls back to even date splits if leg-by-leg day counts don't fit
 * the trip's total date range. Never throws.
 */

import { cleanDestination } from "@/lib/ai/conversation";

export type ParsedLeg = {
  destination: string;
  nights?: number; // null if not specified by user
};

export type LegWithDates = {
  destination: string;
  startDate: string; // ISO YYYY-MM-DD
  endDate: string; // ISO YYYY-MM-DD
};

/**
 * Parse just the destinations + per-leg night counts from a freeform
 * string. Doesn't assign dates — that's `assignDatesToLegs`'s job.
 */
export function parseLegs(input: string): ParsedLeg[] | null {
  const s = input.trim();
  if (!s) return null;

  // Pick the right separator based on what the user actually wrote.
  // When EXPLICIT leg markers exist ("then", "and then", "plus",
  // "followed by", "after that", or the X-"to"-Y connector), split on
  // ONLY those — they're unambiguous leg boundaries. Commas in a long
  // sentence are clause breaks, not leg breaks ("Pebble Beach for 3
  // nights, August 8 2026, group of 4..."), and splitting on them
  // shreds the input into a wall of garbage "legs" (dates, course
  // names, dinner clauses).
  //
  // "X to Y" matters because users type it all the time — "Spain to
  // Portofino", "Pinehurst to Pebble Beach". Without it the input
  // either looks single-leg (no inter-leg flight generated) or the
  // bare-and fallback fires and the second leg ends up carrying
  // trailing conversational junk into the title.
  //
  // Only fall back to comma/bare-and splitting when there's no THEN
  // marker — that preserves the "Capri, Lake Como, Portofino" case
  // (three explicit places, no other connectives).
  const THEN_RE =
    /\s+(?:and\s+then|after\s+that|followed\s+by|then|plus|to)\s+/i;
  const hasThen = THEN_RE.test(s);
  const splitRe = hasThen
    ? THEN_RE
    : /\s*(?:,\s*(?:and\s+)?|\s+and\s+)\s*/i;
  const parts = s.split(splitRe);
  if (parts.length < 2) return null; // single-leg, caller handles

  // For each part, try to extract a destination + optional night count.
  // KEEP only parts that look like real places — drop conversational
  // fragments ("play golf", "stay at the nicest hotels", "i want")
  // that survived the split. If ≥2 real-looking legs survive, this is
  // a multi-leg trip. If FEWER than 2 survive — or if more parts were
  // rejected than kept (the input was mostly conversational) — return
  // null and let the caller fall back to single-leg + destination-
  // agent mode rather than persisting a half-broken leg list.
  const legs: ParsedLeg[] = [];
  let rejected = 0;
  for (const raw of parts) {
    const leg = parseLeg(raw);
    if (leg) legs.push(leg);
    else rejected += 1;
  }
  if (legs.length < 2) return null;
  if (rejected > legs.length) return null;
  return legs;
}

function parseLeg(raw: string): ParsedLeg | null {
  let s = raw.trim();
  if (!s) return null;
  // Step 1: trim trailing junk at the FIRST comma/semicolon. A part
  // like "Pebble Beach for 3 nights, August 8 2026, group of 4 from
  // DFW" becomes "Pebble Beach for 3 nights" before we even look for
  // a duration. Without this, anything past the first comma pollutes
  // the destination name.
  s = s.split(/[,;]/)[0].trim();
  if (!s) return null;
  // Step 2: extract a "for N days/nights" suffix if present.
  let nights: number | undefined;
  const durMatch = s.match(/\s+for\s+(\d+)\s+(day|night|week)s?\s*$/i);
  if (durMatch) {
    const n = parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    if (!Number.isNaN(n) && n > 0) {
      // For "days" we treat day count as nights - 1 isn't necessarily
      // right, but most users mean "5 days = 5 nights of lodging" when
      // describing a trip leg. Easier to be lenient and let the user
      // tweak in the result UI.
      nights = unit === "week" ? n * 7 : n;
    }
    s = s.slice(0, durMatch.index).trim();
  }
  const destination = cleanDestination(s);
  if (!destination) return null;
  return { destination, nights };
}

/**
 * Distribute a trip's date range across the parsed legs, respecting
 * per-leg night counts if specified and falling back to even splits
 * otherwise. If trip dates aren't set, returns null (caller should
 * surface a "need dates for multi-leg trips" message OR default the
 * dates upstream).
 */
export function assignDatesToLegs(
  legs: ParsedLeg[],
  tripStartIso: string | null,
  tripEndIso: string | null,
): LegWithDates[] | null {
  if (!tripStartIso || !tripEndIso) return null;
  const start = new Date(tripStartIso);
  const end = new Date(tripEndIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;

  const totalNights = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)),
  );

  // How many nights does each leg want?
  const specifiedSum = legs.reduce((sum, l) => sum + (l.nights ?? 0), 0);
  const unspecifiedCount = legs.filter((l) => l.nights == null).length;

  // Decide per-leg nights:
  //   - If sum of specified nights fits total → distribute remainder
  //     evenly among unspecified legs
  //   - If sum exceeds total → scale all legs proportionally
  //   - If everything unspecified → even split
  const allocations: number[] = [];
  if (specifiedSum <= totalNights && unspecifiedCount > 0) {
    const remainder = totalNights - specifiedSum;
    const perUnspecified = Math.floor(remainder / unspecifiedCount);
    let leftover = remainder - perUnspecified * unspecifiedCount;
    for (const l of legs) {
      if (l.nights != null) allocations.push(l.nights);
      else {
        const extra = leftover > 0 ? 1 : 0;
        if (extra) leftover -= 1;
        allocations.push(perUnspecified + extra);
      }
    }
  } else if (specifiedSum > totalNights) {
    // Scale proportionally so the sum equals totalNights.
    const scale = totalNights / specifiedSum;
    let assigned = 0;
    for (let i = 0; i < legs.length; i++) {
      const want = legs[i].nights ?? totalNights / legs.length;
      const got =
        i === legs.length - 1
          ? totalNights - assigned
          : Math.max(1, Math.round(want * scale));
      allocations.push(got);
      assigned += got;
    }
  } else {
    // No nights specified at all → even split.
    const per = Math.floor(totalNights / legs.length);
    let leftover = totalNights - per * legs.length;
    for (let i = 0; i < legs.length; i++) {
      const extra = leftover > 0 ? 1 : 0;
      if (extra) leftover -= 1;
      allocations.push(per + extra);
    }
  }

  // Sanity: ensure no leg got 0 nights (steal 1 from the longest if so).
  for (let i = 0; i < allocations.length; i++) {
    if (allocations[i] < 1) {
      const longestIdx = allocations.indexOf(Math.max(...allocations));
      if (longestIdx !== i && allocations[longestIdx] > 1) {
        allocations[longestIdx] -= 1;
        allocations[i] = 1;
      }
    }
  }

  // Build leg date ranges. Each leg's startDate is the cumulative offset
  // from tripStart; endDate is start + nights.
  const result: LegWithDates[] = [];
  let cursor = new Date(start);
  for (let i = 0; i < legs.length; i++) {
    const nights = allocations[i];
    const legStart = new Date(cursor);
    const legEnd = new Date(cursor);
    legEnd.setDate(legEnd.getDate() + nights);
    result.push({
      destination: legs[i].destination,
      startDate: legStart.toISOString().slice(0, 10),
      endDate: legEnd.toISOString().slice(0, 10),
    });
    cursor = legEnd;
  }
  return result;
}

/** True if the input looks like a multi-leg request (post-parseLegs). */
export function looksMultiLeg(input: string): boolean {
  const legs = parseLegs(input);
  return legs != null && legs.length >= 2;
}
