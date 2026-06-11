/**
 * Hotelbeds coverage scan — does Hotelbeds carry the hotels our trips pick?
 *
 *   pnpm hotelbeds:coverage                      # scan the built-in luxury list
 *   pnpm hotelbeds:coverage "Adare Manor, Ireland" "Gleneagles, Scotland"
 *
 * For each hotel: geocode via Google Places → Hotelbeds availability in a
 * 5 km radius (the EXACT call the booking path makes) → name-match → print
 * carried/not + the cheapest live rate. Throttled to respect the sandbox
 * rate limit (8 req / 4 s) and the 50-calls/day quota — the default list is
 * 10 hotels = 10 Hotelbeds calls.
 *
 * NOTE: the TEST environment exposes a subset of the production catalog, so
 * a miss here doesn't always mean a miss in production — but a HIT here is
 * definitive, and the hit-rate is a good proxy for real coverage.
 */

import { optionalEnv } from "../src/lib/env";
import {
  hotelbedsConfigured,
  searchAvailability,
  matchHotelByName,
} from "../src/lib/bookings/providers/hotelbeds";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

// The kinds of hotels Pyltrix itineraries actually pick — European luxury
// (Hotelbeds' home turf) + the US golf-resort names (expected agent territory).
const DEFAULT_HOTELS = [
  "Four Seasons Hotel Milano, Milan, Italy",
  "Splendido A Belmond Hotel, Portofino, Italy",
  "The St. Regis Florence, Florence, Italy",
  "Adare Manor, Adare, Ireland",
  "The Gleneagles Hotel, Auchterarder, Scotland",
  "Schlosshotel Münichau, Kitzbühel, Austria",
  "Hotel Le Sirenuse, Positano, Italy",
  "Verdura Resort, Sciacca, Sicily, Italy",
  "The Carolina Hotel Pinehurst Resort, Pinehurst, NC, United States",
  "The Lodge at Pebble Beach, Pebble Beach, CA, United States",
];

async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) return null;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.location",
    },
    body: JSON.stringify({ textQuery: q, maxResultCount: 1 }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    places?: Array<{ location?: { latitude?: number; longitude?: number } }>;
  };
  const loc = json.places?.[0]?.location;
  return loc?.latitude != null && loc?.longitude != null
    ? { lat: loc.latitude, lng: loc.longitude }
    : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!hotelbedsConfigured()) {
    console.error("✗ HOTELBEDS_API_KEY / HOTELBEDS_SECRET not found in .env.local");
    process.exit(1);
  }
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_HOTELS;
  console.log(
    `Scanning ${targets.length} hotels against Hotelbeds (test env, stay ${CHECKIN}→${CHECKOUT})…\n`,
  );

  let hits = 0;
  for (const target of targets) {
    const [name, ...locParts] = target.split(",").map((s) => s.trim());
    const location = locParts.join(", ") || null;
    process.stdout.write(`• ${target}\n`);
    const geo = await geocode(target);
    if (!geo) {
      console.log("   ⚠ couldn't geocode — skipped\n");
      continue;
    }
    try {
      const hotels = await searchAvailability({
        checkIn: CHECKIN,
        checkOut: CHECKOUT,
        adults: 2,
        geolocation: { latitude: geo.lat, longitude: geo.lng, radiusKm: 5 },
      });
      const match = matchHotelByName(hotels, name, location);
      if (match && match.rates[0]) {
        hits++;
        const r = match.rates[0];
        console.log(
          `   ✓ CARRIED as "${match.name}" — from ${r.net ?? "?"} ${match.currency} (${r.rateType})\n`,
        );
      } else if (match) {
        hits++;
        console.log(`   ✓ CARRIED as "${match.name}" — but no rate for these dates\n`);
      } else {
        console.log(
          `   ✗ not matched (${hotels.length} other hotels available within 5 km) → browser agent would book it\n`,
        );
      }
    } catch (e) {
      console.log(`   ✗ API error: ${(e as Error).message}\n`);
    }
    // Stay safely under the sandbox limit (8 req / 4 s).
    await sleep(700);
  }

  console.log(
    `Done: ${hits}/${targets.length} carried by Hotelbeds (test catalog). ` +
      `Misses fall to LiteAPI or the browser agent — nothing goes unbooked.`,
  );
}

main().catch((e) => {
  console.error(`✗ Coverage scan failed: ${(e as Error).message}`);
  process.exit(1);
});
