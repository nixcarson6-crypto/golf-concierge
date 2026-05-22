/**
 * Google Places photo lookup. Takes a venue name + optional location
 * hint and returns a single hero photo URL we can render in the
 * itinerary item dialog ("here's what The Carolina Hotel looks like",
 * "here's a shot of Pinehurst No. 2", etc.).
 *
 * Uses Google Places API (New) Text Search + Photos endpoints. Caches
 * aggressively client-side via Next's default fetch cache and falls
 * back to null on any failure so a missing photo never breaks the
 * dialog.
 */

import { NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";

const PLACES_BASE = "https://places.googleapis.com/v1/places";

export async function GET(req: NextRequest) {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) {
    console.warn(
      "[places/photo] GOOGLE_MAPS_SERVER_API_KEY is not set — photos disabled.",
    );
    return new Response(JSON.stringify({ photoUrl: null, reason: "no-key" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const loc = (req.nextUrl.searchParams.get("loc") ?? "").trim();
  if (!query) {
    return new Response(
      JSON.stringify({ photoUrl: null, reason: "no-query" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const textQuery = loc ? `${query} ${loc}` : query;
  try {
    const searchRes = await fetch(`${PLACES_BASE}:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.photos",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 1,
        rankPreference: "RELEVANCE",
      }),
      next: { revalidate: 86_400 },
    });
    if (!searchRes.ok) {
      // Loud logging — this is the key diagnostic surface when photos
      // don't show. Google's error body tells you exactly why (API not
      // enabled, key restricted, etc.). Strip the API key from any
      // accidental echo before logging.
      const errText = (await searchRes.text().catch(() => ""))
        .replace(apiKey, "[REDACTED_KEY]")
        .slice(0, 500);
      console.warn(
        `[places/photo] Google searchText ${searchRes.status} for "${textQuery}": ${errText}`,
      );
      return new Response(
        JSON.stringify({
          photoUrl: null,
          reason: `google-${searchRes.status}`,
          detail: errText.slice(0, 200),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    type SearchResponse = {
      places?: Array<{
        id?: string;
        photos?: Array<{ name?: string }>;
      }>;
    };
    const searchJson = (await searchRes.json()) as SearchResponse;
    const first = searchJson.places?.[0];
    const photoName = first?.photos?.[0]?.name;
    if (!photoName) {
      console.info(
        `[places/photo] No photo found for "${textQuery}" (Google returned ${searchJson.places?.length ?? 0} places, ${first?.photos?.length ?? 0} photos).`,
      );
      return new Response(
        JSON.stringify({ photoUrl: null, reason: "no-photo" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const photoUrl =
      `https://places.googleapis.com/v1/${photoName}/media` +
      `?key=${encodeURIComponent(apiKey)}&maxWidthPx=1200`;

    return new Response(JSON.stringify({ photoUrl }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (err) {
    console.warn(
      `[places/photo] fetch threw for "${textQuery}":`,
      err instanceof Error ? err.message : err,
    );
    return new Response(
      JSON.stringify({
        photoUrl: null,
        reason: "exception",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
}
