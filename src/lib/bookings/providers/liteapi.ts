/**
 * LiteAPI — primary hotel booking provider.
 *
 * Flow: search rates → prebook (locks price) → book. We use this for every
 * hotel LiteAPI covers (~2M properties); the browser agent is the FALLBACK
 * for the luxury-independent properties LiteAPI doesn't carry.
 *
 * Two base hosts (LiteAPI v3): search/static data on api.*, booking on book.*.
 * Auth is a single header, X-API-Key, the same sandbox key for both.
 *
 * Field names below are LiteAPI v3 as documented; `pnpm check:liteapi` hits
 * the live sandbox and prints the real response so we can correct anything
 * that drifted before wiring it into the booking flow. Every call fails LOUD
 * (tagged error with the API's own message) — never a silent null.
 */

import { env, optionalEnv } from "@/lib/env";

const SEARCH_BASE = "https://api.liteapi.travel/v3.0";
const BOOK_BASE = "https://book.liteapi.travel/v3.0";

export function liteapiConfigured(): boolean {
  return Boolean(optionalEnv("LITEAPI_KEY"));
}

/** Raw fetch with auth + JSON, throwing a tagged error on any non-2xx. */
async function liteFetch<T = unknown>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "X-API-Key": env("LITEAPI_KEY"),
      "Content-Type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const j = json as { error?: { description?: string }; message?: string };
    const msg = j?.error?.description ?? j?.message ?? text.slice(0, 240);
    throw new Error(`[liteapi] ${init?.method ?? "GET"} ${path} → ${res.status}: ${msg}`);
  }
  return json as T;
}

/* -------------------------------------------------------------------------- */
/* Static data — map a venue/city to LiteAPI hotel IDs                          */
/* -------------------------------------------------------------------------- */

export type LiteHotel = { id: string; name: string };

/** List hotels in a city/country so we can resolve a venue name → hotelId. */
export async function listHotels(args: {
  countryCode: string;
  cityName?: string;
  limit?: number;
}): Promise<LiteHotel[]> {
  const params = new URLSearchParams({
    countryCode: args.countryCode,
    limit: String(args.limit ?? 25),
    ...(args.cityName ? { cityName: args.cityName } : {}),
  });
  const json = await liteFetch<{ data?: Array<{ id?: string; hotelId?: string; name?: string }> }>(
    SEARCH_BASE,
    `/data/hotels?${params.toString()}`,
  );
  return (json.data ?? []).map((h) => ({
    id: String(h.id ?? h.hotelId ?? ""),
    name: h.name ?? "(unnamed)",
  }));
}

/* -------------------------------------------------------------------------- */
/* Name → hotelId resolution                                                   */
/* -------------------------------------------------------------------------- */

// Generic words that shouldn't count as a "match" on their own — otherwise
// "Comfort Inn" would match "Inn at Spanish Bay". A real match needs a
// DISTINCTIVE shared token (splendido / adare / phoenician / seasons).
const GENERIC_TOKENS = new Set([
  "the", "a", "an", "and", "by", "at", "of", "hotel", "hotels", "resort",
  "resorts", "spa", "inn", "lodge", "suites", "suite", "collection", "golf",
  "club", "country", "house", "grand", "palace", "villa", "rooms", "place",
]);

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !GENERIC_TOKENS.has(t)),
  );
}

// City-name spelling pairs so "Milano" in a hotel name is recognised as the
// city "Milan" (and vice versa). Mirrors providers/hotelbeds.ts.
const PLACE_ALIASES: Record<string, string> = {
  milano: "milan", firenze: "florence", roma: "rome", venezia: "venice",
  napoli: "naples", torino: "turin", genova: "genoa", sevilla: "seville",
  lisboa: "lisbon", münchen: "munich", muenchen: "munich", wien: "vienna",
  praha: "prague", köln: "cologne", koeln: "cologne",
};

function canonPlace(t: string): string {
  return PLACE_ALIASES[t] ?? t;
}

/**
 * Resolve an itinerary hotel name to a LiteAPI hotelId. Lists the city's
 * hotels and matches on DISTINCTIVE shared tokens (so "Comfort Inn" doesn't
 * masquerade as "Inn at Spanish Bay").
 *
 * City-name tokens are WEAK evidence: every hotel in Milan has "Milano"
 * somewhere, so a match must share a STRONG token — a real brand word
 * ("Seasons", "Regis", "Splendido"). Without this, "Four Seasons Hotel
 * Milano" could resolve to any hotel with "Milano" in its name — a
 * wrong-hotel booking, the worst failure mode we have. When the venue name
 * is built ONLY of place words ("Hotel Portofino"), every wanted token
 * must match instead.
 *
 * Returns the best match, or null when LiteAPI doesn't carry the property
 * → caller falls back to the browser agent.
 */
export async function resolveHotelId(args: {
  name: string;
  cityName: string;
  countryCode: string;
}): Promise<{ id: string; name: string } | null> {
  // Strip a trailing room/suite descriptor ("Splendido — Belmond Suite").
  const cleanName = args.name.split(/[—–-]/)[0]?.trim() || args.name;
  const wanted = nameTokens(cleanName);
  if (wanted.size === 0) return null;

  let hotels: LiteHotel[];
  try {
    hotels = await listHotels({ countryCode: args.countryCode, cityName: args.cityName, limit: 100 });
  } catch {
    return null;
  }

  const placeTokens = new Set(
    [...nameTokens(args.cityName)].map(canonPlace),
  );
  const strongWanted = new Set(
    [...wanted].filter((t) => !placeTokens.has(canonPlace(t))),
  );

  let best: { id: string; name: string } | null = null;
  let bestScore = 0;
  for (const h of hotels) {
    const have = new Set([...nameTokens(h.name)].map(canonPlace));
    let shared = 0;
    let strongShared = 0;
    for (const t of wanted) {
      if (have.has(canonPlace(t))) {
        shared++;
        if (strongWanted.has(t)) strongShared++;
      }
    }
    // PRECISION GATE: a candidate must be substantially ABOUT the wanted
    // hotel, not just mention its name among unrelated words. A vacation
    // rental like "Hideaway — Blackberry Farm — Hot Tub — Fire Pit — Pet
    // Friendly" shares the brand tokens ("blackberry", "farm") but drowns
    // them in a dozen others; booking it for "Blackberry Farm" would send the
    // guest to the WRONG property — the worst failure we have. So require the
    // matched DISTINCTIVE tokens to be a meaningful fraction of the
    // candidate's distinctive tokens (place words don't count as noise).
    const haveDistinctive = new Set(
      [...have].filter((t) => !placeTokens.has(t)),
    );
    const precision =
      haveDistinctive.size > 0 ? strongShared / haveDistinctive.size : 0;
    const qualifies =
      strongWanted.size > 0
        ? strongShared >= 1 && precision >= 0.34
        : shared === wanted.size;
    if (qualifies && shared > bestScore) {
      bestScore = shared;
      best = h;
    }
  }
  return best;
}

export type LiteRate = {
  hotelId: string;
  name?: string;
  /** The offerId to prebook for the cheapest available rate, or null. */
  cheapestOfferId: string | null;
  /** Cheapest total for the stay in `currency`, major units, or null. */
  cheapestTotal: number | null;
  currency: string;
  /** ALL offers (one per room type), cheapest first — prebook fallbacks
   *  for when an individual rate 400s with "no prebook availability". */
  offers: Array<{ offerId: string; total: number | null }>;
};

/**
 * Search live rates for a city (or explicit hotelIds) + dates + occupancy.
 * Returns one row per hotel with its cheapest bookable offer. An empty array
 * means "LiteAPI has nothing here" → caller falls back to the browser agent.
 */
export async function searchHotelRates(args: {
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  adults: number;
  cityName?: string;
  countryCode?: string;
  hotelIds?: string[];
  currency?: string;
  guestNationality?: string;
}): Promise<LiteRate[]> {
  const currency = args.currency ?? "USD";
  const body: Record<string, unknown> = {
    checkin: args.checkin,
    checkout: args.checkout,
    currency,
    guestNationality: args.guestNationality ?? "US",
    occupancies: [{ adults: Math.max(1, args.adults), children: [] }],
    ...(args.hotelIds?.length ? { hotelIds: args.hotelIds } : {}),
    ...(args.cityName ? { cityName: args.cityName } : {}),
    ...(args.countryCode ? { countryCode: args.countryCode } : {}),
  };
  const json = await liteFetch<{ data?: LiteRawHotel[] }>(SEARCH_BASE, "/hotels/rates", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (json.data ?? []).map((h) => summarizeHotel(h, currency));
}

/** Loose shape of a hotel entry in /hotels/rates — kept permissive because
 *  the exact nesting is what check:liteapi verifies against the live API. */
type LiteRawHotel = {
  hotelId?: string;
  id?: string;
  name?: string;
  roomTypes?: Array<{
    offerId?: string;
    rates?: Array<{
      retailRate?: { total?: Array<{ amount?: number; currency?: string }> };
    }>;
  }>;
};

function summarizeHotel(h: LiteRawHotel, fallbackCurrency: string): LiteRate {
  let currency = fallbackCurrency;
  // Collect EVERY offer (one per room type), cheapest first — not just the
  // single cheapest. Prebook can 400 on an individual rate ("no prebook
  // availability" — stale/non-prebookable), and the right response is to
  // try the NEXT rate, not give up on the whole hotel.
  const offers: Array<{ offerId: string; total: number | null }> = [];
  for (const rt of h.roomTypes ?? []) {
    if (!rt.offerId) continue;
    let rtCheapest: number | null = null;
    for (const rate of rt.rates ?? []) {
      const total = rate.retailRate?.total?.[0]?.amount ?? null;
      if (total != null && (rtCheapest == null || total < rtCheapest)) {
        rtCheapest = total;
        currency = rate.retailRate?.total?.[0]?.currency ?? currency;
      }
    }
    offers.push({ offerId: rt.offerId, total: rtCheapest });
  }
  offers.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  return {
    hotelId: String(h.hotelId ?? h.id ?? ""),
    name: h.name,
    cheapestOfferId: offers[0]?.offerId ?? null,
    cheapestTotal: offers[0]?.total ?? null,
    currency,
    offers,
  };
}

/** Debug only (check:liteapi): the raw first-hotel JSON from /hotels/rates,
 *  so we can verify the real field nesting against this file's assumptions. */
export async function debugRatesShape(args: {
  checkin: string;
  checkout: string;
  adults: number;
  cityName?: string;
  countryCode?: string;
}): Promise<unknown> {
  const json = await liteFetch<{ data?: unknown[] }>(SEARCH_BASE, "/hotels/rates", {
    method: "POST",
    body: JSON.stringify({
      checkin: args.checkin,
      checkout: args.checkout,
      currency: "USD",
      guestNationality: "US",
      occupancies: [{ adults: args.adults, children: [] }],
      ...(args.cityName ? { cityName: args.cityName } : {}),
      ...(args.countryCode ? { countryCode: args.countryCode } : {}),
    }),
  });
  return Array.isArray(json.data) ? (json.data[0] ?? null) : json;
}

/* -------------------------------------------------------------------------- */
/* Prebook + book (write — booking host)                                       */
/* -------------------------------------------------------------------------- */

export type LitePrebook = { prebookId: string; total: number | null; currency: string };

/** Lock the price for an offer before booking. Returns the prebookId. */
export async function prebook(offerId: string): Promise<LitePrebook> {
  const json = await liteFetch<{
    data?: { prebookId?: string; price?: number; currency?: string };
  }>(BOOK_BASE, "/rates/prebook", {
    method: "POST",
    body: JSON.stringify({ offerId, usePaymentSdk: false }),
  });
  const d = json.data ?? {};
  if (!d.prebookId) throw new Error("[liteapi] prebook returned no prebookId");
  return { prebookId: d.prebookId, total: d.price ?? null, currency: d.currency ?? "USD" };
}

export type LiteBooking = {
  bookingId: string;
  status: string;
  confirmationCode: string | null;
};

/**
 * Complete the booking against a prebookId.
 *
 * Payment method — LiteAPI has NO way to inject an external/virtual card
 * server-side (the Stripe-Issuing virtual card only works for the browser
 * agent, which types it into a real checkout). Your options:
 *  - ACC_CREDIT_CARD (default): charges the card on YOUR LiteAPI account per
 *    booking — no wallet pre-funding. Put a business CREDIT card on the account
 *    and Stripe pays you out (~T+2) well before the bill is due (~T+30), so the
 *    customer's payment covers it and you're never actually out of pocket.
 *  - WALLET: draw down a prepaid balance you top up in advance.
 * Override per-deploy with LITEAPI_PAYMENT_METHOD.
 */
export async function book(args: {
  prebookId: string;
  holder: { firstName: string; lastName: string; email: string };
  guests: Array<{ firstName: string; lastName: string; email: string }>;
  paymentMethod?: string;
}): Promise<LiteBooking> {
  const json = await liteFetch<{
    data?: { bookingId?: string; status?: string; supplierBookingId?: string };
  }>(BOOK_BASE, "/rates/book", {
    method: "POST",
    body: JSON.stringify({
      prebookId: args.prebookId,
      holder: args.holder,
      guests: args.guests.map((g, i) => ({ occupancyNumber: i + 1, ...g })),
      payment: {
        method:
          args.paymentMethod ??
          optionalEnv("LITEAPI_PAYMENT_METHOD") ??
          "ACC_CREDIT_CARD",
      },
    }),
  });
  const d = json.data ?? {};
  if (!d.bookingId) throw new Error("[liteapi] book returned no bookingId");
  return {
    bookingId: d.bookingId,
    status: d.status ?? "unknown",
    confirmationCode: d.supplierBookingId ?? d.bookingId ?? null,
  };
}
