/**
 * "Does this venue actually need a reservation?" — single source of truth.
 *
 * Carson's call: not every restaurant on a trip needs the agent to book
 * it. A casual dive bar, a beach taco shack, a quick lunch spot — you
 * walk in. Running the booking agent on those wastes Browserbase time
 * and ends in form_not_found anyway.
 *
 * We use Google Places' own `reservable` flag as the primary signal —
 * it's a real boolean Google publishes per venue (e.g. via the
 * `reservable: true` attribute on its Place record). Backed up by
 * `priceLevel` for venues where Google hasn't set the flag explicitly.
 *
 * Decision is per ITEM TYPE because the rules differ:
 *   - LODGING, TEE_TIME, SPA, NIGHTLIFE — ALWAYS need a reservation.
 *     These don't show up in Google as casually walk-in regardless of
 *     priceLevel; even an inexpensive course needs a tee time.
 *   - DINING — defer to Google. reservable=true means yes; false means
 *     walk-in; null + priceLevel ≤ INEXPENSIVE means almost certainly
 *     walk-in; null + higher priceLevel means we DEFAULT TO YES so we
 *     don't accidentally skip a real reservation venue.
 *   - ACTIVITY / EXPERIENCE — same as DINING — defer.
 *   - FLIGHT, FREE_TIME, TRANSPORT — never agent-bookable here.
 */

import type { PlaceContact, PriceLevel } from "@/lib/places/contact";

export type ReservationNeed =
  /** Venue accepts/needs a reservation — book it with the agent. */
  | "required"
  /** Walk-in venue — no reservation needed. Skip the agent, show a
   *  "walk in, no booking needed" note in the UI. */
  | "walk_in"
  /** We don't know either way (Google didn't say). For safety we still
   *  let the customer book if they want, but UI labels it differently. */
  | "unknown";

/**
 * The set of item types where we should even ASK Google. Other types
 * either don't have a Google Places record (FLIGHT, TRANSPORT,
 * FREE_TIME) or always require booking regardless (LODGING, TEE_TIME,
 * SPA, NIGHTLIFE).
 */
const DEFER_TO_GOOGLE = new Set(["DINING", "ACTIVITY"]);

const ALWAYS_REQUIRES_RESERVATION = new Set([
  "LODGING",
  "TEE_TIME",
  "SPA",
  "NIGHTLIFE",
]);

export function classifyReservation(args: {
  itemType: string;
  contact: PlaceContact | null;
}): ReservationNeed {
  const { itemType, contact } = args;
  if (ALWAYS_REQUIRES_RESERVATION.has(itemType)) return "required";
  if (!DEFER_TO_GOOGLE.has(itemType)) return "unknown";

  const reservable = contact?.reservable ?? null;
  const priceLevel = contact?.priceLevel ?? null;

  if (reservable === true) return "required";
  if (reservable === false) return "walk_in";

  // No explicit signal from Google. Use priceLevel as a tiebreaker:
  // INEXPENSIVE/FREE places (taco shops, dive bars, food trucks) are
  // almost always walk-in; MODERATE+ default to "required" so we don't
  // accidentally skip a real reservation venue with a missing flag.
  if (priceLevel === "PRICE_LEVEL_FREE" || priceLevel === "PRICE_LEVEL_INEXPENSIVE") {
    return "walk_in";
  }
  if (priceLevel != null) return "required";
  return "unknown";
}

/** Short human-readable badge for the UI. */
export function reservationLabel(need: ReservationNeed): string {
  switch (need) {
    case "required":
      return "Reservation";
    case "walk_in":
      return "Walk-in · no booking needed";
    default:
      return "Booking optional";
  }
}

export type { PriceLevel };
