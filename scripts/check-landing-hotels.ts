/**
 * Verify the hotels showcased on the landing page are actually in LiteAPI's
 * inventory and bookable — so the homepage only ever shows trips we can really
 * book via the API, not resort-direct misses.
 *
 *   pnpm check:landing-hotels
 *
 * For each hotel it resolves the name → LiteAPI hotelId and searches rates by
 * id (the exact production path). Prints ✓ with the cheapest rate, or ✗ if
 * LiteAPI doesn't carry it. Exit code is non-zero unless every hotel is
 * bookable, so it can gate a deploy if you want.
 */

import {
  liteapiConfigured,
  resolveHotelId,
  searchHotelRates,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-10-04";
const CHECKOUT = "2026-10-08";

// Keep this in sync with the hotels in src/components/landing/landing.tsx.
const HOTELS = [
  { label: "Scottsdale", name: "Fairmont Scottsdale Princess", cityName: "Scottsdale", countryCode: "US" },
  { label: "Palm Springs", name: "JW Marriott Desert Springs Resort & Spa", cityName: "Palm Desert", countryCode: "US" },
  { label: "Algarve", name: "Conrad Algarve", cityName: "Almancil", countryCode: "PT" },
  { label: "Marbella", name: "Puente Romano Beach Resort", cityName: "Marbella", countryCode: "ES" },
];

async function main() {
  if (!liteapiConfigured()) {
    console.error("✗ LITEAPI_KEY not found in .env.local");
    process.exit(1);
  }
  console.log(
    `Checking ${HOTELS.length} landing-page hotels against LiteAPI (${CHECKIN} → ${CHECKOUT})…\n`,
  );

  let ok = 0;
  for (const h of HOTELS) {
    process.stdout.write(`• ${h.label} — ${h.name} (${h.cityName}, ${h.countryCode}) … `);
    try {
      const hotel = await resolveHotelId({
        name: h.name,
        cityName: h.cityName,
        countryCode: h.countryCode,
      });
      if (!hotel) {
        console.log("✗ NOT in LiteAPI inventory");
        continue;
      }
      const rates = await searchHotelRates({
        checkin: CHECKIN,
        checkout: CHECKOUT,
        adults: 2,
        hotelIds: [hotel.id],
        countryCode: h.countryCode,
      });
      const offer = rates.find((r) => r.cheapestOfferId);
      if (!offer?.cheapestOfferId) {
        console.log(`resolved (${hotel.id}) but ✗ no bookable rate for these dates`);
        continue;
      }
      console.log(`✓ bookable — from $${offer.cheapestTotal} ${offer.currency} (id ${hotel.id})`);
      ok += 1;
    } catch (e) {
      console.log(`✗ error: ${(e as Error).message.slice(0, 110)}`);
    }
  }

  console.log(`\n${ok}/${HOTELS.length} bookable via LiteAPI.`);
  if (ok < HOTELS.length) {
    console.log(
      "Any ✗ above shouldn't be on the landing page — tell Claude and it'll swap in a confirmed one (e.g. Splendido Portofino / Four Seasons Florence).",
    );
  }
  process.exit(ok === HOTELS.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
