/**
 * Prove LiteAPI's EUROPEAN luxury coverage + measure real booking-API speed.
 *
 *   pnpm check:liteapi
 *
 * For each European market: the search round-trip TIME, the price range, the
 * 5 priciest properties, and a scan for real luxury brands (Four Seasons,
 * Ritz, Aman, Belmond, Rosewood…). Retries once on a 429 rate-limit and
 * paces requests so the sandbox doesn't throttle. Read-only — no booking.
 */

import {
  liteapiConfigured,
  searchHotelRates,
  listHotels,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

const MARKETS = [
  { label: "Florence, Italy", countryCode: "IT", cityName: "Florence" },
  { label: "Milan, Italy", countryCode: "IT", cityName: "Milan" },
  { label: "Paris, France", countryCode: "FR", cityName: "Paris" },
];

const LUXURY = [
  "four seasons", "ritz", "st. regis", "st regis", "waldorf", "fairmont",
  "mandarin oriental", "peninsula", "aman", "rosewood", "belmond", "bulgari",
  "montage", "auberge", "park hyatt", "jw marriott", "conrad", "edition",
  "savoy", "savoia", "danieli", "gritti", "cipriani", "hassler", "de russie",
  "le bristol", "plaza", "crillon", "george v", "shangri", "raffles",
];

const isLuxury = (n: string) => {
  const s = n.toLowerCase();
  return LUXURY.some((k) => s.includes(k));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a market search, retrying once on a 429 throttle. */
async function searchWithRetry(m: (typeof MARKETS)[number]) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const t0 = Date.now();
      const rates = await searchHotelRates({
        checkin: CHECKIN,
        checkout: CHECKOUT,
        adults: 2,
        countryCode: m.countryCode,
        cityName: m.cityName,
        currency: "USD",
      });
      return { rates, ms: Date.now() - t0 };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("429") && attempt === 1) {
        console.log("  …rate-limited, waiting 4s and retrying");
        await sleep(4000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
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
      const { rates, ms } = await searchWithRetry(m);
      const hotels = await listHotels({
        countryCode: m.countryCode,
        cityName: m.cityName,
        limit: 100,
      });
      const nameById = new Map(hotels.map((h) => [h.id, h.name]));
      const priced = rates
        .filter((r) => r.cheapestTotal != null)
        .map((r) => ({ ...r, name: r.name ?? nameById.get(r.hotelId) ?? r.hotelId }))
        .sort((a, b) => (b.cheapestTotal ?? 0) - (a.cheapestTotal ?? 0));

      console.log(`  ⏱  search round-trip: ${(ms / 1000).toFixed(1)}s`);
      if (priced.length === 0) {
        console.log("  (no bookable rates)\n");
        await sleep(1500);
        continue;
      }
      console.log(
        `  ${rates.length} hotels · range $${priced[priced.length - 1].cheapestTotal} → $${priced[0].cheapestTotal} (2 nights)`,
      );
      console.log("  PRICIEST:");
      priced.slice(0, 5).forEach((r) => console.log(`    • ${r.name} — $${r.cheapestTotal}`));

      const lux = hotels.filter((h) => isLuxury(h.name));
      console.log(`  LUXURY NAMES (${lux.length} of ${hotels.length} listed):`);
      if (lux.length === 0) console.log("    — none matched —");
      lux.slice(0, 12).forEach((h) => console.log(`    ★ ${h.name}`));
    } catch (e) {
      console.error(`  ✗ ${(e as Error).message}`);
    }
    console.log("");
    await sleep(1500); // pace requests to dodge the sandbox rate limit
  }

  console.log("Read the ⏱ times: that's how fast LiteAPI books vs. the agent's ~8 min.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
