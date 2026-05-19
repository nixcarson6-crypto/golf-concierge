/**
 * Yelp Reservations integration. Two-step:
 *   1. Find the restaurant via Yelp Fusion business search (name + city).
 *   2. Hold a slot and confirm via Yelp Reservations endpoints.
 *
 * If YELP_FUSION_API_KEY isn't set we fall back to a "link-out" response
 * that tells the AI to surface a reservation URL the user can tap to
 * finalise themselves. This is the honest path: we don't pretend to have
 * booked a Resy- or OpenTable-exclusive restaurant.
 *
 * Docs: https://docs.developer.yelp.com/docs/reservation
 */

import { optionalEnv } from "@/lib/env";
import { nanoid } from "nanoid";

const YELP_BASE = "https://api.yelp.com/v3";

export type BookRestaurantInput = {
  restaurantName: string;
  city: string;
  dateTimeISO: string;
  partySize: number;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

export type BookRestaurantResult =
  | {
      ok: true;
      bookingReference: string;
      providerReference: string;
      restaurantName: string;
      isStub: boolean;
    }
  | {
      ok: false;
      fallback: "link";
      restaurantName: string;
      reservationUrl: string;
      reason: string;
    }
  | { ok: false; error: string };

export async function bookRestaurant(
  input: BookRestaurantInput,
): Promise<BookRestaurantResult> {
  const apiKey = optionalEnv("YELP_FUSION_API_KEY");

  if (!apiKey) {
    return linkFallback(input, "Yelp Reservations API not yet configured");
  }

  // Step 1: find the business
  const searchUrl = new URL(`${YELP_BASE}/businesses/search`);
  searchUrl.searchParams.set("term", input.restaurantName);
  searchUrl.searchParams.set("location", input.city);
  searchUrl.searchParams.set("limit", "5");

  let searchRes: Response;
  try {
    searchRes = await fetch(searchUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Yelp network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!searchRes.ok) {
    return linkFallback(
      input,
      `Yelp search returned ${searchRes.status} — falling back to link.`,
    );
  }

  type YelpSearchResp = {
    businesses?: Array<{ id: string; name: string; url: string }>;
  };
  const sj = (await searchRes.json().catch(() => ({}))) as YelpSearchResp;
  const match = sj.businesses?.find(
    (b) => b.name.toLowerCase() === input.restaurantName.toLowerCase(),
  ) ?? sj.businesses?.[0];
  if (!match) {
    return linkFallback(input, "Restaurant not found on Yelp.");
  }

  // Step 2: hold the slot. Yelp's reservations endpoint shape varies by tier;
  // we implement the documented partner shape. If it 404s/403s we surface a
  // fallback link rather than pretending.
  const holdUrl = `${YELP_BASE}/reservations/${match.id}/holds`;
  let holdRes: Response;
  try {
    holdRes = await fetch(holdUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        date_time: input.dateTimeISO,
        covers: input.partySize,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Yelp network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!holdRes.ok) {
    return {
      ok: false,
      fallback: "link",
      restaurantName: match.name,
      reservationUrl: match.url,
      reason: `Yelp couldn't hold a slot at ${match.name} (${holdRes.status}). Reserve directly.`,
    };
  }

  type YelpHoldResp = { hold_id?: string };
  const hj = (await holdRes.json().catch(() => ({}))) as YelpHoldResp;
  const holdId = hj.hold_id;
  if (!holdId) {
    return {
      ok: false,
      fallback: "link",
      restaurantName: match.name,
      reservationUrl: match.url,
      reason: "Yelp didn't return a hold id; tap the link to reserve.",
    };
  }

  // Step 3: confirm hold → reservation
  const confirmUrl = `${YELP_BASE}/reservations/holds/${holdId}/reservation`;
  let confirmRes: Response;
  try {
    confirmRes = await fetch(confirmUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        first_name: input.contactName.split(" ")[0],
        last_name: input.contactName.split(" ").slice(1).join(" ") || "Guest",
        email: input.contactEmail,
        phone: input.contactPhone,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Yelp network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!confirmRes.ok) {
    return {
      ok: false,
      fallback: "link",
      restaurantName: match.name,
      reservationUrl: match.url,
      reason: `Hold expired or rejected at ${match.name}. Reserve directly.`,
    };
  }

  type YelpConfirmResp = { reservation_id?: string; confirmation_number?: string };
  const cj = (await confirmRes.json().catch(() => ({}))) as YelpConfirmResp;
  return {
    ok: true,
    bookingReference: cj.confirmation_number ?? cj.reservation_id ?? holdId,
    providerReference: cj.reservation_id ?? holdId,
    restaurantName: match.name,
    isStub: false,
  };
}

function linkFallback(
  input: BookRestaurantInput,
  reason: string,
): BookRestaurantResult {
  // Without a Yelp partner key we can't programmatically reserve; we ALSO
  // can't pretend we did. Surface a Google-search link the user can tap;
  // the AI will quote it in chat.
  const q = encodeURIComponent(
    `${input.restaurantName} ${input.city} reservation`,
  );
  return {
    ok: false,
    fallback: "link",
    restaurantName: input.restaurantName,
    reservationUrl: `https://www.google.com/search?q=${q}`,
    reason,
  };
}

// Returned to the AI on success of a stub-style flow we don't currently use,
// but kept exported for future course-bundle stub mode if needed.
export function _stubReservationRef(): string {
  return `STUB-RSV-${nanoid(8).toUpperCase()}`;
}
