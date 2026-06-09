/**
 * Live golf-course search near a location, via Google Places (New).
 *
 * This is the cure for the AI missing nearby courses (it knew the famous
 * Verdura but not Il Picciolo, 40 min from Taormina). Instead of relying on
 * the model's memory, we hand it REAL courses near the destination/hotel —
 * with Google ratings + addresses — so it always picks the best LOCAL option.
 * Best-effort: returns [] on any failure (the agent falls back to its own
 * knowledge).
 */

import { optionalEnv } from "@/lib/env";

const PLACES_BASE = "https://places.googleapis.com/v1/places";

export type NearbyCourse = {
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  website: string | null;
};

/**
 * Find golf courses near `location` (a city, or "Hotel, City"), ranked by
 * Google's relevance, filtered to actual golf courses.
 */
export async function searchGolfCoursesNear(
  location: string,
  limit = 12,
): Promise<NearbyCourse[]> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  const loc = (location ?? "").trim();
  if (!apiKey || !loc) return [];
  try {
    const res = await fetch(`${PLACES_BASE}:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri",
      },
      body: JSON.stringify({
        textQuery: `golf courses near ${loc}`,
        includedType: "golf_course",
        maxResultCount: Math.min(20, limit),
        rankPreference: "RELEVANCE",
      }),
      // Course inventory near a place is stable — cache a week.
      next: { revalidate: 604_800 },
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => ""))
        .replace(apiKey, "[KEY]")
        .slice(0, 300);
      console.warn(`[places/golf] searchText ${res.status} for "${loc}": ${t}`);
      return [];
    }
    const json = (await res.json()) as {
      places?: Array<{
        displayName?: { text?: string };
        formattedAddress?: string;
        rating?: number;
        userRatingCount?: number;
        websiteUri?: string;
      }>;
    };
    return (json.places ?? [])
      .map((p) => ({
        name: p.displayName?.text ?? "",
        address: p.formattedAddress ?? null,
        rating: p.rating ?? null,
        ratingCount: p.userRatingCount ?? null,
        website: p.websiteUri ?? null,
      }))
      .filter((c) => c.name);
  } catch (e) {
    console.warn(`[places/golf] ${(e as Error).message}`);
    return [];
  }
}

/** Compact, prompt-ready lines: "★4.6 (320) — Il Picciolo Etna Golf Club — Castiglione…". */
export function formatCoursesForPrompt(courses: NearbyCourse[]): string {
  return courses
    .map((c) => {
      const stars = c.rating != null ? `★${c.rating}` : "★?";
      const count = c.ratingCount != null ? ` (${c.ratingCount})` : "";
      const addr = c.address ? ` — ${c.address}` : "";
      return `- ${stars}${count} ${c.name}${addr}`;
    })
    .join("\n");
}
