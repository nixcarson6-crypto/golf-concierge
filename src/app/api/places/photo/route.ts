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
    return new Response(JSON.stringify({ photoUrl: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const loc = (req.nextUrl.searchParams.get("loc") ?? "").trim();
  if (!query) {
    return new Response(JSON.stringify({ photoUrl: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const textQuery = loc ? `${query} ${loc}` : query;
  try {
    // Step 1: text search → first matching place's photo references.
    const searchRes = await fetch(`${PLACES_BASE}:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Field mask: only request what we need. Cheaper + faster.
        "X-Goog-FieldMask": "places.id,places.displayName,places.photos",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 1,
        // Bias toward "best fit" for tourist/dining venues.
        rankPreference: "RELEVANCE",
      }),
      // Cache the lookup for a day — venue photos don't change often
      // and this keeps API spend bounded.
      next: { revalidate: 86_400 },
    });
    if (!searchRes.ok) {
      return new Response(JSON.stringify({ photoUrl: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(JSON.stringify({ photoUrl: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 2: photo media URL. Google's photo endpoint returns the
    // bytes directly when called server-side, but we redirect the
    // client to the media URL so the browser can cache + render
    // without proxying through our server.
    const photoUrl =
      `https://places.googleapis.com/v1/${photoName}/media` +
      `?key=${encodeURIComponent(apiKey)}&maxWidthPx=1200`;

    return new Response(JSON.stringify({ photoUrl }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Browser-side cache for the same lookup. Same TTL as our
        // server-side revalidate so the layers agree.
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (err) {
    console.warn("[places/photo] threw:", err);
    return new Response(JSON.stringify({ photoUrl: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
