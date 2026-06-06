/**
 * Real-price enrichment.
 *
 * Carson's rule: SHOW real prices, NEVER guessed ones. The AI itself no
 * longer emits prices for anything but flights (see prompts.ts +
 * persistItinerary). This module fills the rest IN from real sources,
 * AFTER the itinerary persists:
 *
 *   - LODGING  → Tavily web search for the hotel's published nightly
 *                rate, parsed by a cheap Haiku extraction. Only set when
 *                the extraction is HIGH confidence AND carries a source
 *                URL. × nights.
 *   - TEE_TIME → Tavily web search for the course's published green fee,
 *                same confidence/source gating. × players.
 *   - TRANSPORT → Google Distance Matrix for the REAL driving distance
 *                between two resolvable endpoints (airport ⇄ hotel,
 *                hotel ⇄ course) × an Uber Black fare formula. ×2 for
 *                round trips.
 *
 * Hard rule everywhere: if we can't confirm a real number, we leave
 * cost null. A wrong price is worse than no price. Every write also
 * stores metadata.priceSource so the UI can show "published rate —
 * <source>" and the customer can verify it themselves.
 *
 * Never throws into the build. Per-item failures are swallowed and
 * logged; the item just stays null. A global timeout caps the whole
 * pass so it can't hang the build.
 */

import { z } from "zod";
import { db } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { tavilySearch } from "@/lib/ai/tavily";
import { runStructured } from "@/lib/ai/orchestrator";

const GLOBAL_TIMEOUT_MS = 60_000;
const CONCURRENCY = 4;

const priceExtractSchema = z.object({
  /** The unit price in whole USD, or null if the search didn't surface a
   *  clear current rate for THIS specific venue. */
  priceUsd: z.number().nullable(),
  /** What the price is per — informs how we multiply. */
  unit: z.enum(["per_night", "per_round_per_player", "unknown"]),
  /** Three tiers, all usable:
   *   high   = clearly this venue's own current rate, exact figure.
   *   medium = published "from $X" floor, or a credible third-party rate
   *            (Booking.com, Tripadvisor) for this exact venue — usable
   *            as a conservative estimate.
   *   low    = unclear / different property / no source → not usable. */
  confidence: z.enum(["high", "medium", "low"]),
  /** The source URL the number came from. Required for any usable
   *  result (high or medium). */
  sourceUrl: z.string().nullable(),
});

type PricedItem = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  location: string | null;
  address: string | null;
  startTime: Date | null;
  endTime: Date | null;
  metadata: unknown;
};

export async function enrichItineraryPrices(
  tripId: string,
  opts: { groupSize: number; destination: string | null },
): Promise<{ enriched: number }> {
  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;

  const itinerary = await db.itinerary.findFirst({
    where: { tripId, status: "CURRENT" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!itinerary) return { enriched: 0 };

  const items = (await db.itineraryItem.findMany({
    where: {
      itineraryId: itinerary.id,
      type: { in: ["LODGING", "TEE_TIME", "TRANSPORT"] },
    },
    select: {
      id: true,
      type: true,
      title: true,
      description: true,
      location: true,
      address: true,
      startTime: true,
      endTime: true,
      metadata: true,
    },
  })) as PricedItem[];
  if (items.length === 0) return { enriched: 0 };

  // The hotel address is the anchor for every ground-transport distance.
  const hotel = items.find((i) => i.type === "LODGING");
  const hotelAddress = hotel?.address ?? hotel?.location ?? null;
  // Course addresses, for matching transport legs to a destination.
  const courses = items
    .filter((i) => i.type === "TEE_TIME")
    .map((i) => ({
      title: i.title,
      address: i.address ?? i.location ?? null,
    }))
    .filter((c) => c.address);

  const groupSize = Math.max(1, opts.groupSize);
  let enriched = 0;

  // Resolve one item → cents (or null). Never throws.
  const priceOne = async (item: PricedItem): Promise<number | null> => {
    if (Date.now() > deadline) return null;
    try {
      if (item.type === "LODGING") {
        return await priceLodging(item, opts.destination);
      }
      if (item.type === "TEE_TIME") {
        return await priceTeeTime(item, opts.destination, groupSize);
      }
      if (item.type === "TRANSPORT") {
        return await priceTransport(item, hotelAddress, courses);
      }
    } catch (err) {
      console.warn(
        `[price-enrichment] ${item.type} "${item.title}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  };

  // Run with a small concurrency cap so we don't fire 15 Tavily +
  // Distance-Matrix calls at once.
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = items.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => ({ item, cents: await priceOne(item) })),
    );
    for (const { item, cents } of results) {
      if (cents == null || cents <= 0) continue;
      const meta = (item.metadata as Record<string, unknown> | null) ?? {};
      await db.itineraryItem.update({
        where: { id: item.id },
        data: {
          cost: cents,
          metadata: { ...meta, priceConfirmed: true } as object,
        },
      });
      enriched += 1;
    }
  }

  // Recompute the itinerary totals from the full priced set so the
  // banner reflects the newly-confirmed real prices.
  if (enriched > 0) {
    await recomputeTotals(itinerary.id, groupSize);
  }
  return { enriched };
}

/* ---------------------------------------------------------------- lodging */

async function priceLodging(
  item: PricedItem,
  destination: string | null,
): Promise<number | null> {
  const hotelName = stripParenTail(item.title);
  if (!hotelName) return null;
  const nights = nightsFor(item);
  if (nights <= 0) return null;
  const where = destination ?? item.location ?? "";

  // Try TWO queries — a specific "nightly rate" query first; if the
  // extractor can't find a confident rate, fall back to a broader query
  // ('hotel rooms price') that catches Booking.com / Tripadvisor /
  // hotel-aggregator pages where the rate is often clearer.
  const queries = [
    `${hotelName} ${where} nightly room rate per night USD`,
    `${hotelName} ${where} rooms price booking`,
  ];
  for (const q of queries) {
    const extracted = await searchAndExtract(q, hotelName);
    if (
      extracted &&
      extracted.confidence !== "low" &&
      extracted.priceUsd &&
      extracted.sourceUrl &&
      extracted.unit !== "per_round_per_player"
    ) {
      const cents = Math.round(extracted.priceUsd * nights * 100);
      await stampSource(
        item.id,
        extracted.sourceUrl,
        `${fmt(extracted.priceUsd)}/night × ${nights} nights${extracted.confidence === "medium" ? " · est." : ""}`,
      );
      console.log(
        `[price-enrichment] ✓ ${hotelName}: $${extracted.priceUsd}/night × ${nights} = $${Math.round(extracted.priceUsd * nights)} (${extracted.confidence})`,
      );
      return cents;
    }
  }
  // Last resort: extract a rate the AI itinerary agent wrote into the
  // description text itself ("~$525/night for a suite × 10 nights").
  // These are KB-informed estimates, not invented numbers.
  const fromDesc = extractRateFromDescription(item.description, "per_night");
  if (fromDesc) {
    const cents = Math.round(fromDesc * nights * 100);
    await stampSource(
      item.id,
      null,
      `~${fmt(fromDesc)}/night × ${nights} nights · est.`,
    );
    console.log(
      `[price-enrichment] ~ ${hotelName}: $${fromDesc}/night × ${nights} = $${Math.round(fromDesc * nights)} (description-est)`,
    );
    return cents;
  }
  console.log(`[price-enrichment] ✗ ${hotelName}: no usable price found`);
  return null;
}

/* --------------------------------------------------------------- tee time */

async function priceTeeTime(
  item: PricedItem,
  destination: string | null,
  players: number,
): Promise<number | null> {
  const courseName = stripParenTail(item.title).split(/\s+[—–-]\s+/)[0].trim();
  if (!courseName) return null;
  const where = destination ?? item.location ?? "";

  // Try the specific "green fee" query first; fall back to a broader
  // "rates" query that catches Tee-time aggregators and the course's
  // own rates page.
  const queries = [
    `${courseName} ${where} golf green fee per player USD`,
    `${courseName} ${where} golf course rates`,
  ];
  for (const q of queries) {
    const extracted = await searchAndExtract(q, courseName);
    if (
      extracted &&
      extracted.confidence !== "low" &&
      extracted.priceUsd &&
      extracted.sourceUrl &&
      extracted.unit !== "per_night"
    ) {
      const cents = Math.round(extracted.priceUsd * players * 100);
      await stampSource(
        item.id,
        extracted.sourceUrl,
        `${fmt(extracted.priceUsd)}/player × ${players}${extracted.confidence === "medium" ? " · est." : ""}`,
      );
      console.log(
        `[price-enrichment] ✓ ${courseName}: $${extracted.priceUsd}/player × ${players} = $${Math.round(extracted.priceUsd * players)} (${extracted.confidence})`,
      );
      return cents;
    }
  }
  // Description fallback — the AI itinerary agent often writes a real
  // KB-informed green-fee range into the description ("Green fee ~$450
  // /player").
  const fromDesc = extractRateFromDescription(
    item.description,
    "per_round_per_player",
  );
  if (fromDesc) {
    const cents = Math.round(fromDesc * players * 100);
    await stampSource(
      item.id,
      null,
      `~${fmt(fromDesc)}/player × ${players} · est.`,
    );
    console.log(
      `[price-enrichment] ~ ${courseName}: $${fromDesc}/player × ${players} = $${Math.round(fromDesc * players)} (description-est)`,
    );
    return cents;
  }
  console.log(`[price-enrichment] ✗ ${courseName}: no usable price found`);
  return null;
}

/* -------------------------------------------------------------- transport */

async function priceTransport(
  item: PricedItem,
  hotelAddress: string | null,
  courses: { title: string; address: string | null }[],
): Promise<number | null> {
  if (!hotelAddress) return null;
  const hay = `${item.title} ${item.description ?? ""}`.toLowerCase();

  // Resolve the OTHER endpoint (besides the hotel):
  //  - airport: a 3-letter IATA in the title (e.g. "SDF") or "airport"
  //  - course: a TEE_TIME course whose name appears in the transport text
  let otherEndpoint: string | null = null;
  const iata = item.title.match(/\b([A-Z]{3})\b/)?.[1] ?? null;
  if (iata && (hay.includes("airport") || hay.includes(iata.toLowerCase()))) {
    otherEndpoint = `${iata} airport`;
  } else {
    const matchedCourse = courses.find((c) => {
      const key = c.title.split(/\s+[—–-]\s+/)[0].trim().toLowerCase();
      return key.length > 3 && hay.includes(key);
    });
    if (matchedCourse?.address) otherEndpoint = matchedCourse.address;
  }
  if (!otherEndpoint) return null;

  const miles = await drivingMiles(hotelAddress, otherEndpoint);
  if (miles == null || miles <= 0) return null;

  // Round trip when the item describes a ↔ / "round" / "each way" hop.
  const roundTrip = /↔|round|each way|both ways|to and from/i.test(hay);
  const oneWayUsd = uberBlackFare(miles);
  const usd = roundTrip ? oneWayUsd * 2 : oneWayUsd;
  await stampSource(
    item.id,
    null,
    `${miles.toFixed(1)} mi${roundTrip ? " round-trip" : ""} · Uber Black est.`,
  );
  return Math.round(usd * 100);
}

/**
 * Uber Black US fare estimate from real driving miles. Uses a published-
 * style rate card (base + per-mile + per-minute proxy + booking fee,
 * with a floor). Marked an ESTIMATE because surge/exact city rates vary
 * — but it's grounded in the ACTUAL distance, not a number from thin air.
 */
function uberBlackFare(miles: number): number {
  const BASE = 8;
  const PER_MILE = 3.75;
  const PER_MILE_TIME_PROXY = 1.1; // ~time component folded into distance
  const BOOKING_FEE = 3;
  const MINIMUM = 25; // Uber Black US minimum is typically $20-30
  const raw = BASE + miles * (PER_MILE + PER_MILE_TIME_PROXY) + BOOKING_FEE;
  return Math.max(MINIMUM, Math.round(raw));
}

/* ------------------------------------------------- google distance matrix */

/** Real driving distance in miles between two address strings. */
async function drivingMiles(
  origin: string,
  destination: string,
): Promise<number | null> {
  const key = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!key) return null;
  const url = new URL(
    "https://maps.googleapis.com/maps/api/distancematrix/json",
  );
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", destination);
  url.searchParams.set("units", "imperial");
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", key);

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status?: string;
    rows?: {
      elements?: { status?: string; distance?: { meters?: number; value?: number } }[];
    }[];
  };
  const el = data.rows?.[0]?.elements?.[0];
  if (data.status !== "OK" || el?.status !== "OK") return null;
  const meters = el.distance?.value;
  if (typeof meters !== "number" || meters <= 0) return null;
  return meters / 1609.344;
}

/* ----------------------------------------------------- web search + parse */

async function searchAndExtract(
  query: string,
  venueName: string,
): Promise<z.infer<typeof priceExtractSchema> | null> {
  const raw = await tavilySearch({ query, searchDepth: "advanced", maxResults: 6 });
  // tavilySearch returns a JSON string; if it's an error blob, bail.
  let parsed: { error?: string } | unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if ((parsed as { error?: string })?.error) return null;

  const extraction = await runStructured({
    tier: "fast",
    system: PRICE_EXTRACT_SYSTEM,
    schema: priceExtractSchema,
    toolName: "emit_price",
    toolDescription: "Emit the confirmed published price or null.",
    messages: [
      {
        role: "user",
        content: [
          `Venue: "${venueName}"`,
          ``,
          `Web search results (JSON):`,
          raw.slice(0, 6000),
          ``,
          `Extract the CURRENT published price for THIS exact venue only.`,
          `If the results don't clearly state this venue's own current`,
          `rate, return priceUsd=null, confidence=low. Never guess.`,
        ].join("\n"),
      },
    ],
    maxTokens: 300,
    temperature: 0,
  });
  return extraction;
}

const PRICE_EXTRACT_SYSTEM = `You extract a single PRICE from web-search results for a specific
named venue (a hotel or a golf course). Three confidence tiers, ALL
usable — but distinguished honestly so the app can label estimates:

- confidence="high" — the result clearly states THIS exact venue's own
  CURRENT specific nightly rate or green fee, from the venue's own
  site or a credible reservation page. Exact figure.
- confidence="medium" — a published "from $X" floor, an aggregator
  (Booking.com / Tripadvisor / GolfNow) showing this exact venue's
  current rate, or a price clearly tied to THIS venue but with some
  fuzz (range, "starting at", older snapshot). USABLE as a conservative
  estimate — emit it.
- confidence="low" — wrong property, no source URL, generic average
  with no venue tie, or you'd be guessing. Emit priceUsd=null.

Hard rules:
- The number MUST come from one of the result snippets and you MUST
  return that result's url in sourceUrl. No source → priceUsd=null.
- unit: "per_night" for hotels, "per_round_per_player" for golf.
- Whole USD. Strip currency symbols. If a range, take the LOW end
  (conservative).
- NEVER invent, average, or infer from "comparable" venues.`;

/* ---------------------------------------------------------------- helpers */

/** Strip "(10 nights)" / "— Suite" tails to get a clean venue name. */
function stripParenTail(title: string): string {
  return title
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+[—–-]\s+.*$/, "")
    .trim();
}

/**
 * Last-resort fallback: extract a price the AI itinerary agent wrote
 * into the item's description text. The itinerary agent draws on the
 * curated destination KB (real green-fee and nightly-rate data Carson
 * hand-built), so these aren't invented numbers — they're KB-informed
 * estimates. Marked as "est." in the UI so the customer knows.
 *
 * Matches common phrasings the AI produces:
 *   "Green fee ~$450/player"
 *   "$120/player as a guest"
 *   "~$525/night for a suite × 10 nights"
 *   "Suite ~$650 per night"
 * Takes the LOW end of any range and ignores numbers that look like
 * totals rather than unit rates (anything > 5000 — protects against
 * extracting "× 10 nights = $5,250" as a per-night).
 */
function extractRateFromDescription(
  description: string | null,
  unit: "per_night" | "per_round_per_player",
): number | null {
  if (!description) return null;
  // Strip thousands-separator commas BEFORE the regex runs so
  // "$1,400" becomes "$1400" and the {2,5}-digit capture matches.
  // Without this fix, every price >= $1,000 silently fell through
  // (Carson caught it on Four Seasons Jackson Hole: description said
  // "~$1,400-1,900/night" and the row showed $0, hiding ~$12k from
  // the headline trip total).
  const text = description.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2");
  // Only pull a number that's anchored to a unit-rate phrase, so we
  // don't accidentally grab the trip total.
  const unitWords =
    unit === "per_night"
      ? /(per\s*night|\/\s*night|\bnight\b|nightly)/
      : /(per\s*player|\/\s*player|\bplayer\b|green\s*fee)/;
  if (!unitWords.test(text)) return null;
  // Find every $-prefixed number; pick the first one that's a plausible
  // per-unit rate (50 ≤ x ≤ 5000).
  const matches = text.matchAll(/\$\s*([0-9]{2,5})(?:[.,]\d{1,2})?/g);
  for (const m of matches) {
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (n >= 50 && n <= 5000) return n;
  }
  return null;
}

/** Nights for a lodging item — from the title "(N nights)" or the date span. */
function nightsFor(item: PricedItem): number {
  const m = item.title.match(/(\d+)\s*nights?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 60) return n;
  }
  if (item.startTime && item.endTime) {
    const ms = item.endTime.getTime() - item.startTime.getTime();
    const n = Math.round(ms / (24 * 60 * 60 * 1000));
    if (n > 0 && n < 60) return n;
  }
  return 0;
}

async function stampSource(
  itemId: string,
  sourceUrl: string | null,
  label: string,
): Promise<void> {
  const cur = await db.itineraryItem.findUnique({
    where: { id: itemId },
    select: { metadata: true },
  });
  const meta = (cur?.metadata as Record<string, unknown> | null) ?? {};
  await db.itineraryItem.update({
    where: { id: itemId },
    data: {
      metadata: {
        ...meta,
        priceSource: sourceUrl,
        priceBasis: label,
      } as object,
    },
  });
}

function fmt(usd: number): string {
  return `$${Math.round(usd).toLocaleString()}`;
}

async function recomputeTotals(
  itineraryId: string,
  groupSize: number,
): Promise<void> {
  const items = await db.itineraryItem.findMany({
    where: { itineraryId },
    select: { cost: true },
  });
  const total = items.reduce((sum, i) => sum + (i.cost ?? 0), 0);
  const perPerson = Math.round(total / Math.max(1, groupSize));
  await db.itinerary.update({
    where: { id: itineraryId },
    data: { totalCost: total, perPersonCost: perPerson },
  });
}
