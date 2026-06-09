/**
 * Verify LiteAPI coverage — focused on whether it carries LUXURY hotels,
 * not just the cheap ones.
 *
 *   pnpm check:liteapi
 *
 * For each market: total count, the full price RANGE (cheapest → priciest
 * with names), the 5 PRICIEST properties, and a scan of the city's hotel
 * names for real luxury brands (Four Seasons, Ritz, Phoenician, etc.).
 * Read-only sandbox — no booking, no charge.
 */

import {
  liteapiConfigured,
  searchHotelRates,
  listHotels,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

const MARKETS = [
  { label: "Scottsdale, AZ", countryCode: "US", cityName: "Scottsdale" },
  { label: "Pinehurst, NC", countryCode: "US", cityName: "Pinehurst" },
  { label: "Pebble Beach, CA", countryCode: "US", cityName: "Pebble Beach" },
  { label: "Bandon, OR", countryCode: "US", cityName: "Bandon" },
];

// Real luxury brands/names — if any of these show up, LiteAPI carries luxury.
const LUXURY = [
  "four seasons", "ritz-carlton", "ritz carlton", "st. regis", "st regis",
  "waldorf", "fairmont", "mandarin oriental", "peninsula", "aman", "rosewood",
  "montage", "auberge", "phoenician", "park hyatt", "jw marriott", "conrad",
  "edition", "w scottsdale", "the resort", "sanctuary", "boulders", "princess",
  "grand hyatt", "westin", "omni", "lodge at", "inn at", "resort & spa",
];

function isLuxury(name: string): boolean {
  const n = name.toLowerCase();
  return LUXURY.some((k) => n.includes(k));
}

async function main() {
  if (!liteapiConfigured()) {
    console.error("✗ LITEAPI_KEY not found in .env.local");
    process.exit(1);
  }
  console.log(`✓ LITEAPI_KEY detected. ${CHECKIN} → ${CHECKOUT}, 2 adults.\n`);

  for (const m of MARKETS) {
    console.log(`══ ${m.label} ══`);
    try {
      const [rates, hotels] = await Promise.all([
        searchHotelRates({
          checkin: CHECKIN,
          checkout: CHECKOUT,
          adults: 2,
          countryCode: m.countryCode,
          cityName: m.cityName,
        }),
        listHotels({ countryCode: m.countryCode, cityName: m.cityName, limit: 100 }),
      ]);
      const nameById = new Map(hotels.map((h) => [h.id, h.name]));
      const priced = rates
        .filter((r) => r.cheapestTotal != null)
        .map((r) => ({ ...r, name: r.name ?? nameById.get(r.hotelId) ?? r.hotelId }))
        .sort((a, b) => (b.cheapestTotal ?? 0) - (a.cheapestTotal ?? 0));

      if (priced.length === 0) {
        console.log("  (no bookable rates)\n");
        continue;
      }
      const top = priced[0];
      const bottom = priced[priced.length - 1];
      console.log(
        `  ${rates.length} hotels · price range $${bottom.cheapestTotal} → $${top.cheapestTotal} (2 nights)`,
      );
      console.log("  PRICIEST (the luxury end):");
      priced.slice(0, 5).forEach((r) =>
        console.log(`    • ${r.name} — $${r.cheapestTotal}`),
      );

      // Scan ALL hotel names in the city for luxury brands.
      const lux = hotels.filter((h) => isLuxury(h.name));
      console.log(
        `  LUXURY NAMES FOUND (${lux.length} of ${hotels.length} listed):`,
      );
      if (lux.length === 0) console.log("    — none matched the luxury list —");
      lux.slice(0, 10).forEach((h) => console.log(`    ★ ${h.name}`));
    } catch (e) {
      console.error(`  ✗ ${(e as Error).message}`);
    }
    console.log("");
  }

  console.log("Verdict: if the PRICIEST lists / LUXURY NAMES show real 5-stars,");
  console.log("LiteAPI carries luxury and the earlier 'cheap hotels' read was just");
  console.log("my script showing the bottom of the range. If they're still all");
  console.log("budget chains, then luxury genuinely needs the agent / a luxe supplier.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
