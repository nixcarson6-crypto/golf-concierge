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
      .map((l) => titleCaseDestination((l.destination ?? "").trim()))
      .filter((s) => s.length > 0);
  if (legNames.length > 0) return legNames.join(" / ");
  const d = titleCaseDestination((t.destination ?? "").trim());
  if (d.length > 0) return d;
  return (t.title ?? "").trim() || "Untitled trip";
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
