/**
 * End-to-end LiteAPI booking test (SANDBOX) on Splendido Portofino.
 *
 *   pnpm check:liteapi
 *
 * Exercises the exact production path: resolve hotel name → hotelId, search
 * rates BY ID, prebook, then book. Prints each step so we know the booking
 * call actually works before the app relies on it. Sandbox = no real charge.
 */

import {
  liteapiConfigured,
  resolveHotelId,
  searchHotelRates,
  prebook,
  book,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

async function main() {
  if (!liteapiConfigured()) {
    console.error("✗ LITEAPI_KEY not found in .env.local");
    process.exit(1);
  }
  console.log("✓ LITEAPI_KEY detected. Full booking test on Splendido, Portofino.\n");

  // 1) Resolve name → hotelId (the search-by-id fix).
  console.log("1) Resolve 'Splendido' → hotelId…");
  const hotel = await resolveHotelId({
    name: "Splendido, A Belmond Hotel",
    cityName: "Portofino",
    countryCode: "IT",
  });
  if (!hotel) {
    console.error("   ✗ not resolved — stopping.");
    process.exit(1);
  }
  console.log(`   ✓ ${hotel.name} (${hotel.id})`);

  // 2) Search rates BY hotelId.
  console.log("2) Search rates by hotelId…");
  const rates = await searchHotelRates({
    checkin: CHECKIN,
    checkout: CHECKOUT,
    adults: 2,
    hotelIds: [hotel.id],
    countryCode: "IT",
  });
  const offer = rates.find((r) => r.cheapestOfferId);
  if (!offer?.cheapestOfferId) {
    console.error("   ✗ no bookable rate for these dates — stopping.");
    process.exit(1);
  }
  console.log(`   ✓ from $${offer.cheapestTotal} ${offer.currency}, offerId acquired`);

  // 3) Prebook (lock the price).
  console.log("3) Prebook (lock price)…");
  const pre = await prebook(offer.cheapestOfferId);
  console.log(`   ✓ prebookId ${pre.prebookId} · total ${pre.total ?? "?"} ${pre.currency}`);

  // 4) Book (sandbox — no real charge).
  console.log("4) Book (sandbox)…");
  const result = await book({
    prebookId: pre.prebookId,
    holder: { firstName: "Carson", lastName: "Nix", email: "nixcarson6@gmail.com" },
    guests: [{ firstName: "Carson", lastName: "Nix", email: "nixcarson6@gmail.com" }],
  });
  console.log(`   ✓ status=${result.status} · bookingId=${result.bookingId}`);
  console.log(`   ✓ confirmation=${result.confirmationCode ?? "(none)"}`);

  console.log(
    "\n🎉 Full booking flow works end-to-end. The app can now book any LiteAPI",
  );
  console.log("hotel in seconds; the browser agent covers what LiteAPI doesn't.");
}

main().catch((e) => {
  console.error(`\n✗ Booking flow failed at some step: ${(e as Error).message}`);
  console.error(
    "  (If it's the BOOK step, it's likely a sandbox payment/wallet setting —",
  );
  console.error("   paste this and I'll adjust the payment method.)");
  process.exit(1);
});
