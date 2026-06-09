/**
 * Targeted LiteAPI lookup: does it carry specific marquee resorts?
 *
 *   pnpm check:liteapi
 *
 * For each target city we check BOTH:
 *  - the static hotel DB (listHotels) → does the property even EXIST in
 *    LiteAPI, and scan its name for the brand we're after;
 *  - live rates (searchHotelRates) → is it bookable for the dates, + price.
 * This separates "not in LiteAPI at all" from "in LiteAPI, no rates for
 * these dates / city-name didn't match". Read-only — no booking.
 */

import {
  liteapiConfigured,
  searchHotelRates,
  listHotels,
} from "../src/lib/bookings/providers/liteapi";

const CHECKIN = "2026-09-10";
const CHECKOUT = "2026-09-12";

// label, country, city variants to try, and the brand keywords to look for.
const TARGETS = [
  { label: "Splendido, Portofino", cc: "IT", cities: ["Portofino", "Santa Margherita Ligure"], look: ["splendido", "belmond"] },
  { label: "Aman Venice", cc: "IT", cities: ["Venice", "Venezia"], look: ["aman"] },
  { label: "Milan (re-test by name)", cc: "IT", cities: ["Milan", "Milano"], look: ["four seasons", "bulgari", "mandarin", "armani"] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listWithRetry(cc: string, city: string) {
  for (let a = 1; a <= 2; a++) {
    try {
      return await listHotels({ countryCode: cc, cityName: city, limit: 100 });
    } catch (e) {
      if ((e as Error).message.includes("429") && a === 1) {
        await sleep(4000);
        continue;
      }
      throw e;
    }
  }
  return [];
}

async function ratesWithRetry(cc: string, city: string) {
  for (let a = 1; a <= 2; a++) {
    try {
      const t0 = Date.now();
      const rates = await searchHotelRates({
        checkin: CHECKIN,
        checkout: CHECKOUT,
        adults: 2,
        countryCode: cc,
        cityName: city,
        currency: "USD",
      });
      return { rates, ms: Date.now() - t0 };
    } catch (e) {
      if ((e as Error).message.includes("429") && a === 1) {
        await sleep(4000);
        continue;
      }
      throw e;
    }
  }
  return { rates: [], ms: 0 };
}

async function main() {
  if (!liteapiConfigured()) {
    console.error("✗ LITEAPI_KEY not found in .env.local");
    process.exit(1);
  }
  console.log(`✓ LITEAPI_KEY detected. ${CHECKIN} → ${CHECKOUT}, 2 adults.\n`);

  for (const t of TARGETS) {
    console.log(`══ ${t.label} ══`);
    let found = false;
    for (const city of t.cities) {
      try {
        const hotels = await listWithRetry(t.cc, city);
        const hits = hotels.filter((h) =>
          t.look.some((k) => h.name.toLowerCase().includes(k)),
        );
        console.log(`  [${city}] ${hotels.length} hotels in LiteAPI's DB`);
        if (hits.length) {
          found = true;
          hits.forEach((h) => console.log(`    ★ FOUND: ${h.name} (${h.id})`));
        }
        await sleep(1200);
      } catch (e) {
        console.error(`  [${city}] ✗ ${(e as Error).message}`);
      }
    }

    // Price the first city variant if anything was listed.
    try {
      const { rates, ms } = await ratesWithRetry(t.cc, t.cities[0]);
      const priced = rates.filter((r) => r.cheapestTotal != null);
      console.log(`  ⏱ rate search: ${(ms / 1000).toFixed(1)}s · ${priced.length} bookable for these dates`);
    } catch (e) {
      console.error(`  ✗ rates: ${(e as Error).message}`);
    }

    console.log(found ? "  → IN LiteAPI ✓\n" : "  → NOT found in LiteAPI (agent's job)\n");
    await sleep(1500);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
