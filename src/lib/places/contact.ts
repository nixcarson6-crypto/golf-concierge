/**
 * Google Places contact lookup — shared logic.
 *
 * Extracted so BOTH the /api/places/contact route (browser-facing) AND
 * the browser-agent's run-booking pipeline (server-to-server) can use it.
 * The agent path previously fetched the HTTP route, which Clerk
 * middleware blocked (no session cookie → 404), so the agent could never
 * find a venue's website and every booking died at form_not_found.
 * Calling this function directly sidesteps auth entirely.
 *
 * Never throws — returns nulls on any error so callers can degrade
 * gracefully.
 */

import { optionalEnv } from "@/lib/env";

const PLACES_BASE = "https://places.googleapis.com/v1/places";

export type PlaceContact = {
  website: string | null;
  phone: string | null;
  address: string | null;
};

export async function lookupPlaceContact(
  query: string,
  loc?: string,
): Promise<PlaceContact> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  const empty: PlaceContact = { website: null, phone: null, address: null };
  if (!apiKey) {
    console.warn(
      "[places/contact] GOOGLE_MAPS_SERVER_API_KEY is not set — contact lookup disabled.",
    );
    return empty;
  }
  const q = (query ?? "").trim();
  if (!q) return empty;

  const textQuery = loc?.trim() ? `${q} ${loc.trim()}` : q;
  try {
    const searchRes = await fetch(`${PLACES_BASE}:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.websiteUri,places.internationalPhoneNumber,places.nationalPhoneNumber,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 1,
        rankPreference: "RELEVANCE",
      }),
      next: { revalidate: 604_800 },
    });
    if (!searchRes.ok) {
      const errText = (await searchRes.text().catch(() => ""))
        .replace(apiKey, "[REDACTED_KEY]")
        .slice(0, 500);
      console.warn(
        `[places/contact] Google searchText ${searchRes.status} for "${textQuery}": ${errText}`,
      );
      return empty;
    }
    type SearchResponse = {
      places?: Array<{
        websiteUri?: string;
        internationalPhoneNumber?: string;
        nationalPhoneNumber?: string;
        formattedAddress?: string;
      }>;
    };
    const json = (await searchRes.json()) as SearchResponse;
    const first = json.places?.[0];
    const phone =
      first?.internationalPhoneNumber ?? first?.nationalPhoneNumber ?? null;
    return {
      website: first?.websiteUri ?? null,
      phone,
      address: first?.formattedAddress ?? null,
    };
  } catch (err) {
    console.warn(
      `[places/contact] fetch threw for "${textQuery}":`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}
