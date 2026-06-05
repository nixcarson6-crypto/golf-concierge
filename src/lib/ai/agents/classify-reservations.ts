/**
 * Walk-in detection pass.
 *
 * Runs after the itinerary persists, parallel-fetches Google Places
 * for each DINING / ACTIVITY item, and classifies each one as
 * "required" / "walk_in" / "unknown" using the venue's own `reservable`
 * + `priceLevel` flags. Result is persisted on item.metadata.
 *
 * The booking UI + the agent routes both read this so a casual taco
 * spot with no reservation system never fires the agent and never gets
 * counted as a missed booking. Customers see "Walk-in" on those rows
 * instead of "Tap to book."
 *
 * Cheap (one Places search per qualifying item, capped concurrency,
 * 30s global timeout). Never throws into the build — per-item failures
 * just leave the item as "unknown" which renders normally.
 */

import { db } from "@/lib/db";
import { lookupPlaceContact } from "@/lib/places/contact";
import {
  classifyReservation,
  type ReservationNeed,
} from "@/lib/places/reservation-need";

const GLOBAL_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

const DEFER_TYPES = new Set(["DINING", "ACTIVITY"]);

type Item = {
  id: string;
  type: string;
  title: string;
  location: string | null;
  metadata: unknown;
};

export async function classifyTripReservations(
  tripId: string,
): Promise<{ classified: number; walkIns: number }> {
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  const itinerary = await db.itinerary.findFirst({
    where: { tripId, status: "CURRENT" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!itinerary) return { classified: 0, walkIns: 0 };

  const items = (await db.itineraryItem.findMany({
    where: {
      itineraryId: itinerary.id,
      type: { in: ["DINING", "ACTIVITY"] },
    },
    select: {
      id: true,
      type: true,
      title: true,
      location: true,
      metadata: true,
    },
  })) as Item[];
  if (items.length === 0) return { classified: 0, walkIns: 0 };

  let classified = 0;
  let walkIns = 0;

  const classifyOne = async (item: Item): Promise<ReservationNeed | null> => {
    if (Date.now() > deadline) return null;
    if (!DEFER_TYPES.has(item.type)) return null;
    // Clean meal/activity prefix the same way run-booking does for the
    // venue search — "Dinner — Nick & Sam's" → "Nick & Sam's".
    const venueName = item.title
      .replace(
        /^(dinner|lunch|breakfast|brunch|drinks|cocktails)\s*(—|–|-|:|at)\s*/i,
        "",
      )
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .trim() || item.title;
    try {
      const contact = await lookupPlaceContact(
        venueName,
        item.location ?? undefined,
      );
      const need = classifyReservation({ itemType: item.type, contact });
      return need;
    } catch {
      return null;
    }
  };

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => ({ item, need: await classifyOne(item) })),
    );
    for (const { item, need } of results) {
      if (need == null) continue;
      classified += 1;
      if (need === "walk_in") walkIns += 1;
      const meta = (item.metadata as Record<string, unknown> | null) ?? {};
      await db.itineraryItem.update({
        where: { id: item.id },
        data: {
          metadata: { ...meta, reservationNeed: need } as object,
        },
      });
    }
  }
  console.log(
    `[classify-reservations] classified ${classified} items, ${walkIns} walk-in.`,
  );
  return { classified, walkIns };
}
