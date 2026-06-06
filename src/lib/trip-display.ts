/**
 * The single source of truth for what a trip is CALLED in the UI —
 * headers, tabs, dashboard tiles, share pages, summaries, exports.
 *
 * Rule: just the destination(s). For multi-leg trips, join legs with " / ".
 * Never show the AI-generated title (which embeds party size + month —
 * "pinehurst · 2 players · Jun" — and looks noisy next to clean
 * destination labels). We only fall back to the raw title when a trip
 * genuinely has no destination yet (a draft still being built).
 *
 * Every render site that names a trip MUST import this helper. That way
 * we can't accidentally show a noisy title in one place and a clean
 * destination in another.
 */

export type TripDisplayInput = {
  title?: string | null;
  destination?: string | null;
  /** Optional ordered list of legs. Empty/undefined for single-destination. */
  legs?: Array<{ destination?: string | null }> | null;
};

export function tripDisplayLabel(t: TripDisplayInput): string {
  const legNames =
    (t.legs ?? [])
      .map((l) => stripLocationSuffix((l.destination ?? "").trim()))
      .filter((s) => s.length > 0 && !looksLikeSentence(s))
      .map(titleCaseDestination);
  if (legNames.length > 0) return legNames.join(" / ");
  const d = stripLocationSuffix((t.destination ?? "").trim());
  if (d.length > 0 && !looksLikeSentence(d)) return titleCaseDestination(d);
  const title = stripLocationSuffix((t.title ?? "").trim());
  if (title.length > 0 && !looksLikeSentence(title)) return titleCaseDestination(title);
  return "Generating destination…";
}

/**
 * Strip the "in [City]" / ", [Region]" / " - [Country]" suffixes the
 * AI loves to append to venue names. The agent returns
 * "Fields Ranch in Frisco" / "Pebble Beach, California" /
 * "Cabot Cliffs - Nova Scotia" — Carson wants just the venue name.
 *
 * Conservative: only strips when the suffix is a separator (in / , / -)
 * followed by 1-2 word location. Doesn't touch names like
 * "The Inn at Spanish Bay" (no "in"), "TPC at Sawgrass" (no "in"), or
 * "St. Andrews" (no separator).
 */
export function stripLocationSuffix(s: string): string {
  if (!s) return s;
  let out = s;
  // " in City" or " in City Region" → strip
  out = out.replace(/\s+in\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?$/i, "");
  // ", City" or ", State" → strip
  out = out.replace(/,\s*[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?$/i, "");
  // " - Region" or " — Region" → strip
  out = out.replace(/\s+[-–—]\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?$/i, "");
  // " and find/pick/explore the X" → strip. Catches conversational
  // tails that snuck into the destination field on older quiz inputs
  // (e.g. "Portofino and Find the Closet Golf Course There"). The
  // parser now strips these at write-time; this is a safety net for
  // pre-fix rows already in the DB.
  out = out.replace(
    /\s+and\s+(?:find|pick|explore|see|visit|check|try|grab|get|book|do|play|stay|eat|drink|tour|shop|hit|swim|surf|ski|relax|chill|hang)\b.*$/i,
    "",
  );
  return out.trim() || s;
}

/**
 * Reject obviously-conversational strings at the display layer so a
 * stale DB row from before the parser hardening lands ("The Top-Rated
 * Course in Tennessee. If they have a resort…") doesn't render as a
 * trip title. Mirrors the same shape-checks in cleanDestination —
 * sentence punctuation, conditional connectives, descriptive
 * determiners + superlatives. Anything that survives is short enough
 * to plausibly be a real place name.
 */
function looksLikeSentence(s: string): boolean {
  if (!s) return false;
  if (s.length > 70) return true;
  // Strip common place-name abbreviation periods first so "St. Moritz"
  // / "Mt. Whitney" / "Ste. Genevieve" / "Ft. Lauderdale" don't get
  // mistaken for sentence boundaries by the period-space check.
  const stripped = s.replace(
    /\b(st|mt|ste|sta|ft|fort|mont|pt|sr|jr)\.\s+/gi,
    "$1 ",
  );
  if (/\.\s+\S/.test(stripped)) return true;
  if (/\b(if|but|only|unless|would|could|should|might|maybe|preferably|ideally)\b/i.test(s)) return true;
  if (/^the\s+(top[\s-]?rated|best|cheapest|nicest|finest|greatest|fanciest|highest[\s-]?rated)\b/i.test(s)) return true;
  if (/^(i|we|you|they|us)\s+(want|need|wanna|would|gonna|going|should|might|could|hope|love|like|plan|think)\b/i.test(s)) return true;
  return false;
}

/**
 * Title-case a destination so user-typed input ("erin hills") renders as
 * "Erin Hills". Preserves all-caps tokens (DFW), already-mixed-case
 * words (McLean), and keeps small articles lowercase mid-string.
 * Mirrors the helper in `src/lib/ai/conversation.ts` — duplicated here
 * intentionally so this module stays a leaf (no AI/db deps) and is safe
 * to import from server pages and client components alike.
 */
function titleCaseDestination(s: string): string {
  if (!s) return s;
  const SMALL_WORDS = new Set([
    "of", "the", "at", "in", "on", "and", "or", "a", "an", "to", "for",
    "de", "del", "la", "las", "los", "le", "les", "di", "da", "do",
  ]);
  const words = s.split(/(\s+|[-/])/);
  return words
    .map((w, i) => {
      if (/^\s+$/.test(w) || w === "-" || w === "/") return w;
      if (/[A-Z]/.test(w) && /[a-z]/.test(w)) return w;
      if (/^[A-Z]{2,}$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(
        /([\p{L}])(\p{L}*)/u,
        (_m, first: string, rest: string) => first.toUpperCase() + rest,
      );
    })
    .join("");
}
