/**
 * Schedule intelligence — pure functions over itinerary items.
 *
 * Used by the UI to surface conflicts honestly and by the fallback agent to
 * decide whether a re-optimisation pass is warranted.
 *
 * "Conflict" definitions (intentionally conservative):
 *   - Two time-bounded items of different types overlap (e.g. tee time and
 *     dinner overlap in clock time).
 *   - A tee time starts < 60 min after a flight lands at the same destination.
 *   - A flight departs < 90 min after a tee time ends at the same destination.
 *
 * Lodging and FREE_TIME never conflict — they're backdrops, not slots.
 */

import type { ConfirmationState, ItineraryItemType } from "@prisma/client";

export type ScheduleItem = {
  id: string;
  type: ItineraryItemType;
  title: string;
  startTime: string | null;
  endTime: string | null;
};

export type Conflict = {
  itemId: string;
  withItemId: string;
  reason: string;
};

const NON_BLOCKING: ItineraryItemType[] = ["LODGING", "FREE_TIME", "SPA"];

export function detectConflicts(items: ScheduleItem[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const scheduled = items
    .filter((i) => i.startTime && !NON_BLOCKING.includes(i.type))
    .map((i) => ({
      ...i,
      start: new Date(i.startTime!).getTime(),
      end: new Date(i.endTime ?? i.startTime!).getTime() ||
        new Date(i.startTime!).getTime() + 60 * 60 * 1000,
    }))
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < scheduled.length; i++) {
    for (let j = i + 1; j < scheduled.length; j++) {
      const a = scheduled[i];
      const b = scheduled[j];
      if (b.start >= a.end) break;
      // Overlap.
      conflicts.push({
        itemId: b.id,
        withItemId: a.id,
        reason: `Overlaps with "${a.title}" (${shortTime(new Date(a.start))}–${shortTime(new Date(a.end))})`,
      });
    }
  }

  // Flight / tee-time proximity rules.
  for (let i = 0; i < scheduled.length - 1; i++) {
    const a = scheduled[i];
    const b = scheduled[i + 1];
    const gapMs = b.start - a.end;
    const gapMin = gapMs / 60000;
    if (a.type === "FLIGHT" && b.type === "TEE_TIME" && gapMin < 60) {
      conflicts.push({
        itemId: b.id,
        withItemId: a.id,
        reason: `Tee time only ${Math.max(0, Math.round(gapMin))} min after flight arrives — likely too tight.`,
      });
    }
    if (a.type === "TEE_TIME" && b.type === "FLIGHT" && gapMin < 90) {
      conflicts.push({
        itemId: a.id,
        withItemId: b.id,
        reason: `Flight only ${Math.max(0, Math.round(gapMin))} min after tee time ends — round runs long, you'll miss it.`,
      });
    }
  }

  return dedupe(conflicts);
}

function dedupe(conflicts: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const k = [c.itemId, c.withItemId].sort().join("::");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type ConfirmationGroup = {
  total: number;
  confirmed: number;
  pending: number;
  failed: number;
};

export function summariseConfirmations(
  items: { confirmationState: ConfirmationState }[],
): ConfirmationGroup {
  let confirmed = 0;
  let pending = 0;
  let failed = 0;
  for (const i of items) {
    if (i.confirmationState === "CONFIRMED") confirmed++;
    else if (i.confirmationState === "FAILED" || i.confirmationState === "UNAVAILABLE")
      failed++;
    else pending++;
  }
  return { total: items.length, confirmed, pending, failed };
}

function shortTime(d: Date) {
  return d.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Estimated drive time in minutes between two items at the same destination.
 * Uses a coarse haversine + 35 mph assumption when we have lat/lng; otherwise
 * returns null. Replace with Google Distance Matrix when key is configured.
 */
export function estimateDriveMinutes(
  a: { latitude: number | null; longitude: number | null },
  b: { latitude: number | null; longitude: number | null },
): number | null {
  if (a.latitude == null || a.longitude == null) return null;
  if (b.latitude == null || b.longitude == null) return null;
  const R = 6371; // km
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  const km = R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  const miles = km * 0.621371;
  // Assume 30 mph average local driving + 5 min overhead.
  return Math.max(5, Math.round((miles / 30) * 60 + 5));
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}
