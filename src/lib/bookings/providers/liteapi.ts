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
/* Rate search                                                                 */
/* -------------------------------------------------------------------------- */

export type LiteRate = {
  hotelId: string;
  name?: string;
  /** The offerId to prebook for the cheapest available rate, or null. */
  cheapestOfferId: string | null;
  /** Cheapest total for the stay in `currency`, major units, or null. */
  cheapestTotal: number | null;
  currency: string;
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
  let cheapestOfferId: string | null = null;
  let cheapestTotal: number | null = null;
  let currency = fallbackCurrency;
  for (const rt of h.roomTypes ?? []) {
    for (const rate of rt.rates ?? []) {
      const total = rate.retailRate?.total?.[0]?.amount ?? null;
      if (total != null && (cheapestTotal == null || total < cheapestTotal)) {
        cheapestTotal = total;
        cheapestOfferId = rt.offerId ?? null;
        currency = rate.retailRate?.total?.[0]?.currency ?? currency;
      }
    }
  }
  return {
    hotelId: String(h.hotelId ?? h.id ?? ""),
    name: h.name,
    cheapestOfferId,
    cheapestTotal,
    currency,
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
 * Complete the booking against a prebookId. `payment.method` defaults to
 * the LiteAPI wallet (sandbox-funded) — swap to a pass-through card model
 * once we route the customer's Stripe charge through here.
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
      payment: { method: args.paymentMethod ?? "WALLET" },
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
