/**
 * Google Places contact lookup. Takes a venue name + optional location
 * hint and returns the venue's website URL + phone number so the
 * itinerary dialog can show "Visit website" and "Call" buttons for any
 * item we can't book directly (most dining, spas, activities, etc).
 *
 * MVP pattern: give the customer a one-tap path to handle their own
 * reservation when we don't have a booking API for that venue. Same
 * spirit as the Uber deep-link for transport.
 *
 * Uses Google Places API (New) Text Search with the websiteUri +
 * internationalPhoneNumber + nationalPhoneNumber field mask. Caches
 * aggressively (these values don't change often) and never fails the
 * dialog — returns nulls on any error.
 */

import { NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";

const PLACES_BASE = "https://places.googleapis.com/v1/places";

export async function GET(req: NextRequest) {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) {
    console.warn(
      "[places/contact] GOOGLE_MAPS_SERVER_API_KEY is not set — contact lookup disabled.",
    );
    return new Response(
      JSON.stringify({ website: null, phone: null, reason: "no-key" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const loc = (req.nextUrl.searchParams.get("loc") ?? "").trim();
  if (!query) {
    return new Response(
      JSON.stringify({ website: null, phone: null, reason: "no-query" }),
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
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.websiteUri,places.internationalPhoneNumber,places.nationalPhoneNumber,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 1,
        rankPreference: "RELEVANCE",
      }),
      next: { revalidate: 604_800 }, // 7 days — phone/website rarely change.
    });
    if (!searchRes.ok) {
      const errText = (await searchRes.text().catch(() => ""))
        .replace(apiKey, "[REDACTED_KEY]")
        .slice(0, 500);
      console.warn(
        `[places/contact] Google searchText ${searchRes.status} for "${textQuery}": ${errText}`,
      );
      return new Response(
        JSON.stringify({
          website: null,
          phone: null,
          reason: `google-${searchRes.status}`,
          detail: errText.slice(0, 200),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    type SearchResponse = {
      places?: Array<{
        id?: string;
        websiteUri?: string;
        internationalPhoneNumber?: string;
        nationalPhoneNumber?: string;
        formattedAddress?: string;
      }>;
    };
    const json = (await searchRes.json()) as SearchResponse;
    const first = json.places?.[0];
    // Prefer the international format for tel: links because it works
    // from any country (US customer calling Italy, etc). Fall back to
    // the national format when international isn't returned.
    const phone =
      first?.internationalPhoneNumber ?? first?.nationalPhoneNumber ?? null;
    return new Response(
      JSON.stringify({
        website: first?.websiteUri ?? null,
        phone,
        address: first?.formattedAddress ?? null,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=604800, immutable",
        },
      },
    );
  } catch (err) {
    console.warn(
      `[places/contact] fetch threw for "${textQuery}":`,
      err instanceof Error ? err.message : err,
    );
    return new Response(
      JSON.stringify({
        website: null,
        phone: null,
        reason: "exception",
        detail: err instanceof Error ? err.message : String(err),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
}
