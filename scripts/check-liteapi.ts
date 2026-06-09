/**
 * Verify the LiteAPI key + see real coverage on Pyltrix's golf markets.
 *
 *   pnpm check:liteapi
 *
 * Runs live sandbox searches for a handful of destinations, prints how many
 * hotels come back with bookable rates, and dumps the raw shape of one hotel
 * so we can lock the client's field names against reality. Read-only — no
 * prebook, no booking, no charge.
 */

import {
  liteapiConfigured,
  searchHotelRates,
  listHotels,
  debugRatesShape,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

const MARKETS = [
  { label: "Bandon, OR", countryCode: "US", cityName: "Bandon" },
  { label: "Pinehurst, NC", countryCode: "US", cityName: "Pinehurst" },
  { label: "Scottsdale, AZ", countryCode: "US", cityName: "Scottsdale" },
  { label: "Missoula, MT", countryCode: "US", cityName: "Missoula" },
];

async function main() {
  if (!liteapiConfigured()) {
    console.error(
      "✗ LITEAPI_KEY not found. Add it to .env.local:\n    LITEAPI_KEY=your_sandbox_key\n",
    );
    process.exit(1);
  }
  console.log(`✓ LITEAPI_KEY detected. Searching ${CHECKIN} → ${CHECKOUT}, 2 adults.\n`);

  // 1) Raw shape from the first market — verifies the client's field names.
  console.log("── Raw response shape (first hotel, Scottsdale) ──");
  try {
    const sample = await debugRatesShape({
      checkin: CHECKIN,
      checkout: CHECKOUT,
      adults: 2,
      countryCode: "US",
      cityName: "Scottsdale",
    });
    console.log(JSON.stringify(sample, null, 2)?.slice(0, 1800) ?? "(empty)");
  } catch (e) {
    console.error(`  ✗ ${(e as Error).message}`);
  }
  console.log("");

  // 2) Coverage per market.
  console.log("── Coverage by market ──");
  for (const m of MARKETS) {
    try {
      const rates = await searchHotelRates({
        checkin: CHECKIN,
        checkout: CHECKOUT,
        adults: 2,
        countryCode: m.countryCode,
        cityName: m.cityName,
      });
      const priced = rates.filter((r) => r.cheapestTotal != null);
      console.log(
        `✓ ${m.label}: ${rates.length} hotels returned, ${priced.length} with live bookable rates`,
      );
      priced
        .sort((a, b) => (a.cheapestTotal ?? 0) - (b.cheapestTotal ?? 0))
        .slice(0, 3)
        .forEach((r) =>
          console.log(
            `    • ${r.name ?? r.hotelId} — from ${r.cheapestTotal} ${r.currency} (offer ${r.cheapestOfferId ? "✓" : "—"})`,
          ),
        );
    } catch (e) {
      console.error(`✗ ${m.label}: ${(e as Error).message}`);
    }
  }
  console.log("");

  // 3) Static hotel list sanity check (name → id resolution path).
  console.log("── Static hotel list (Pinehurst) ──");
  try {
    const hotels = await listHotels({ countryCode: "US", cityName: "Pinehurst", limit: 5 });
    hotels.forEach((h) => console.log(`    • ${h.name} (${h.id})`));
    if (hotels.length === 0) console.log("    (none returned)");
  } catch (e) {
    console.error(`  ✗ ${(e as Error).message}`);
  }

  console.log("\nDone. If rates came back with prices + offer ✓, search is wired correctly.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
