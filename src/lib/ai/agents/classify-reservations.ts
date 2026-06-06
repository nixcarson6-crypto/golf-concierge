/**
 * Walk-in detection + contact-capture pass.
 *
 * Runs after the itinerary persists, parallel-fetches Google Places for
 * each DINING / ACTIVITY / NIGHTLIFE / SPA item, and:
 *   1. persists the venue's `contact { phone, website }` on item.metadata
 *      so the UI can show Call / Draft-email / Visit-site actions WITHOUT
 *      ever running the browser agent (Carson's call — we don't auto-book
 *      restaurants/activities, we hand the customer the venue's number);
 *   2. for DINING / ACTIVITY, classifies each as "required" / "walk_in" /
 *      "unknown" using the venue's own `reservable` + `priceLevel` flags.
 *
 * The booking UI reads both: casual walk-in spots render "Walk-in", and
 * every restaurant/activity surfaces its phone so the customer can call
 * or email the venue directly.
 *
 * Cheap (one Places search per qualifying item, capped concurrency,
 * 30s global timeout). Never throws into the build — per-item failures
 * just leave the item as-is, which renders normally.
 */

import { db } from "@/lib/db";
import { lookupPlaceContact } from "@/lib/places/contact";
import {
  classifyReservation,
  type ReservationNeed,
} from "@/lib/places/reservation-need";

const GLOBAL_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;

// Types we capture venue contact for (so the UI can offer Call / Draft
// email / Visit site). Restaurants, activities, nightlife, spa.
const CONTACT_TYPES = ["DINING", "ACTIVITY", "NIGHTLIFE", "SPA"] as const;
// Of those, the two we also walk-in-classify (reservable vs casual).
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
      type: { in: [...CONTACT_TYPES] },
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

  const resolveOne = async (
    item: Item,
  ): Promise<{
    need: ReservationNeed | null;
    contact: { phone: string | null; website: string | null } | null;
  }> => {
    if (Date.now() > deadline) return { need: null, contact: null };
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
      const need = DEFER_TYPES.has(item.type)
        ? classifyReservation({ itemType: item.type, contact })
        : null;
      return {
        need,
        contact: { phone: contact.phone, website: contact.website },
      };
    } catch {
      return { need: null, contact: null };
    }
  };

  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => ({ item, ...(await resolveOne(item)) })),
    );
    for (const { item, need, contact } of results) {
      // Persist whatever we learned — the contact (phone/website) for the
      // UI's Call/Email/Visit actions, and the walk-in classification when
      // we have it. Skip the write only if we got nothing at all.
      if (need == null && contact == null) continue;
      const meta = (item.metadata as Record<string, unknown> | null) ?? {};
      const nextMeta: Record<string, unknown> = { ...meta };
      if (contact && (contact.phone || contact.website)) {
        nextMeta.contact = contact;
      }
      if (need != null) {
        nextMeta.reservationNeed = need;
        classified += 1;
        if (need === "walk_in") walkIns += 1;
      }
      await db.itineraryItem.update({
        where: { id: item.id },
        data: { metadata: nextMeta as object },
      });
    }
  }
  console.log(
    `[classify-reservations] classified ${classified} items, ${walkIns} walk-in.`,
  );
  return { classified, walkIns };
}
