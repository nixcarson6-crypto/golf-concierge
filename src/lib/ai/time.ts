/**
 * Time helpers for persisting itinerary items.
 *
 * The itinerary model emits times in the VENUE's local wall-clock with no
 * timezone (e.g. "2026-09-12T19:30:00" for a 7:30pm Singapore dinner), plus a
 * separate IANA `timeZone`. These helpers keep the storage convention
 * consistent across every persist path (build + single-item swaps).
 */

/**
 * Parse an item's local wall-clock time into a stored instant.
 *
 * A tz-less datetime is pinned to UTC so the stored instant deterministically
 * encodes the wall-clock digits regardless of the build host's zone (the old
 * `new Date(s)` interpreted it in the server's local zone, so times drifted by
 * the host offset and then re-rendered in the viewer's zone — 7:30pm → 6:30am).
 * The UI reads the instant back in UTC and labels it with the item's
 * `timeZone`. Strings that already carry an offset/Z are respected as-is.
 */
export function parseWallClock(s: string | null | undefined): Date | null {
  if (!s) return null;
  let iso = s.trim();
  if (!iso) return null;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  if (iso.includes("T") && !hasTz) iso = `${iso}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Return `tz` only if it's a valid IANA timezone id, else null. Guards against
 * the model emitting a junk/empty zone — a bad value would throw at render
 * time, so we drop it here and let the UI fall back to no label.
 */
export function validIanaTz(tz: string | null | undefined): string | null {
  if (!tz || typeof tz !== "string") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
