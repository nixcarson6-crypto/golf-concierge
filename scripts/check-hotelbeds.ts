/**
 * End-to-end Hotelbeds booking test (SANDBOX) around Palma de Mallorca —
 * the test environment's most reliably stocked market.
 *
 *   pnpm check:hotelbeds
 *
 * Exercises the production path: availability by geolocation → pick the
 * cheapest rate → checkrates (if RECHECK) → book → CANCEL (so sandbox test
 * bookings clean up after themselves). Prints each step + the API's own
 * error on failure so we can fix field drift fast. Sandbox = no real charge.
 */

import {
  hotelbedsConfigured,
  searchAvailability,
  checkRate,
  book,
  cancelBooking,
} from "../src/lib/bookings/providers/hotelbeds";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";
// Palma de Mallorca — Hotelbeds' home turf, densest sandbox inventory.
const PALMA = { latitude: 39.5696, longitude: 2.6502, radiusKm: 15 };

async function main() {
  if (!hotelbedsConfigured()) {
    console.error("✗ HOTELBEDS_API_KEY / HOTELBEDS_SECRET not found in .env.local");
    process.exit(1);
  }
  console.log("✓ Hotelbeds keys detected. Full booking test near Palma de Mallorca.\n");

  // 1) Availability by geolocation (the same call the booking path makes).
  console.log("1) Search availability (geolocation, 15 km around Palma)…");
  const hotels = await searchAvailability({
    checkIn: CHECKIN,
    checkOut: CHECKOUT,
    adults: 2,
    geolocation: PALMA,
  });
  const hotel = hotels.find((h) => h.rates.length > 0);
  if (!hotel) {
    console.error("   ✗ no hotels with rates — stopping.");
    process.exit(1);
  }
  console.log(`   ✓ ${hotels.length} hotels; testing "${hotel.name}" (code ${hotel.code})`);

  // 2) Cheapest rate; revalidate if RECHECK.
  const cheapest = hotel.rates[0];
  console.log(
    `2) Cheapest rate: ${cheapest.net ?? "?"} ${hotel.currency} · ${cheapest.rateType} · ${cheapest.roomName ?? ""}`,
  );
  let rateKey = cheapest.rateKey;
  if (cheapest.rateType === "RECHECK") {
    console.log("   RECHECK rate — running checkrates…");
    const fresh = await checkRate(cheapest.rateKey);
    rateKey = fresh.rateKey;
    console.log(`   ✓ revalidated at ${fresh.net ?? "?"} ${fresh.currency}`);
  }

  // 3) Book (sandbox credit line — no card, no real charge).
  console.log("3) Book (sandbox)…");
  const result = await book({
    rateKey,
    holder: { firstName: "Carson", lastName: "Nix" },
    adults: 2,
    clientReference: `PYL-CHECK-${Date.now() % 1_000_000}`,
  });
  console.log(`   ✓ status=${result.status} · reference=${result.reference}`);
  console.log(`   ✓ total ${result.totalNet ?? "?"} ${result.currency}`);

  // 4) Cancel so the sandbox booking doesn't linger.
  console.log("4) Cancel the test booking…");
  const status = await cancelBooking(result.reference);
  console.log(`   ✓ cancellation status=${status}`);

  console.log(
    "\n🎉 Hotelbeds flow works end-to-end. Hotels now try LiteAPI → Hotelbeds →",
  );
  console.log("browser agent, in that order — each API miss falls through cleanly.");
}

main().catch((e) => {
  console.error(`\n✗ Hotelbeds flow failed: ${(e as Error).message}`);
  console.error(
    "  (Paste this error and I'll adjust — likely a field-name drift or a",
  );
  console.error("   signature/clock issue. The error above is the API's own message.)");
  process.exit(1);
});
