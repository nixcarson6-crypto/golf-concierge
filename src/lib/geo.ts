/**
 * Lightweight geocoding + distance helpers.
 *
 * Itinerary items only store a free-text `location` (no coordinates), so when
 * we need to know how far apart two venues are — e.g. "is this hotel close to
 * the golf courses?" — we geocode on demand via Google Places (New) Text
 * Search and measure the great-circle distance. Results are cached server-side
 * for a week (venues don't move), so repeated checks are nearly free.
 *
 * No API key → geocode returns null and callers degrade gracefully (skip the
 * proximity check rather than nag with a wrong answer).
 */

import { optionalEnv } from "@/lib/env";

export type LatLng = { lat: number; lng: number };

/** Geocode a venue/place string to coordinates, or null if it can't be found. */
export async function geocodePlace(query: string): Promise<LatLng | null> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) return null;
  const textQuery = query.trim();
  if (!textQuery) return null;
  try {
    const res = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.location",
        },
        body: JSON.stringify({
          textQuery,
          maxResultCount: 1,
          rankPreference: "RELEVANCE",
        }),
        // Venues don't move — cache a week. Cuts the repeated geocodes a
        // hotel swap + course re-pick would otherwise make to ~one each.
        next: { revalidate: 604_800 },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: Array<{ location?: { latitude?: number; longitude?: number } }>;
    };
    const loc = json.places?.[0]?.location;
    if (loc?.latitude == null || loc?.longitude == null) return null;
    return { lat: loc.latitude, lng: loc.longitude };
  } catch {
    return null;
  }
}

/** Great-circle distance between two points, in miles. */
export function distanceMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Beyond this, a golf course is "not close" to where the customer is staying —
 * a 45-min+ each-way commute, not a resort/in-town round. Used to decide
 * whether a hotel swap should offer to re-pick courses nearby.
 */
export const COURSE_FAR_MILES = 40;
