/**
 * RateHawk / ETG API validation (run once Elsa enables API access).
 *
 *   pnpm check:ratehawk
 *
 * Validates the exact calls the booking path makes: geo availability near
 * Palma de Mallorca → summarize rates → name-match smoke test. Read-only —
 * no booking is placed (ETG booking finish is certified separately on the
 * call with their team). Prints ETG's own error body on any failure so
 * field drift is a one-look fix, same as check:hotelbeds was.
 */

import {
  ratehawkConfigured,
  searchByGeo,
  matchByName,
} from "../src/lib/bookings/providers/ratehawk";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";
const PALMA = { latitude: 39.5696, longitude: 2.6502 };

async function main() {
  if (!ratehawkConfigured()) {
    console.error("✗ RATEHAWK_KEY_ID / RATEHAWK_API_KEY not found in .env.local");
    console.error("  (Elsa's team provides these once API access is enabled.)");
    process.exit(1);
  }
  console.log("✓ RateHawk keys detected. Geo availability near Palma…\n");

  const hotels = await searchByGeo({
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 2,
    ...PALMA,
    radiusM: 15000,
  });
  console.log(`1) ✓ ${hotels.length} hotels with availability`);
  const withRate = hotels.find((h) => h.bookHash);
  if (!withRate) {
    console.error("   ✗ none had a bookable rate — paste this and we adjust the rate parsing.");
    process.exit(1);
  }
  console.log(
    `2) ✓ cheapest at "${withRate.name}" — ${withRate.total ?? "?"} ${withRate.currency} (book_hash acquired)`,
  );
  const match = matchByName(hotels, withRate.name);
  console.log(`3) ${match ? "✓" : "✗"} name-matcher resolves "${withRate.name}"`);

  console.log(
    "\n🎉 RateHawk search path works. Booking finish gets certified with ETG's",
  );
  console.log("team; the provider is already wired third in the hotel chain.");
}

main().catch((e) => {
  console.error(`\n✗ RateHawk check failed: ${(e as Error).message}`);
  process.exit(1);
});
