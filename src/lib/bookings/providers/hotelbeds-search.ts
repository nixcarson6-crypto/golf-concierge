/**
 * Real Hotelbeds APITude hotel search.
 *
 * Auth: SHA-256 over (apiKey + secret + utcSeconds). Headers Api-key +
 * X-Signature. Test env is api.test.hotelbeds.com; flip the base URL when
 * we go live.
 *
 * For chat-time "what's the Broadmoor running" answers we search by
 * geolocation (lat/lng + radius) — the LLM can resolve city → coordinates
 * itself and we sidestep Hotelbeds' opaque destination-code lookup table.
 */

import { createHash } from "node:crypto";
import { optionalEnv } from "@/lib/env";

const HOTELBEDS_BASE = "https://api.test.hotelbeds.com";

export type HotelSearchInput = {
  /** Lat/lng of the target city or area. */
  latitude: number;
  longitude: number;
  /** Search radius in km. Default 20km. */
  radiusKm?: number;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  rooms: number;
  adults: number;
  children?: number;
  /** Cap how many hotels to summarize back. */
  maxResults?: number;
};

export type HotelOfferSummary = {
  hotelCode: number;
  name: string;
  categoryName: string; // e.g. "5 STARS"
  zoneName: string | null;
  destinationName: string | null;
  /** Cheapest room rate, total for the stay, in cents. */
  minTotalAmount: number;
  /** Cheapest per-night per-room average, in cents. */
  perNightPerRoomAmount: number;
  currency: string;
  /** Best-cancellation hint we found across the rates. */
  refundable: boolean;
  rooms: Array<{
    name: string;
    rateType: string; // "BOOKABLE" | "RECHECK"
    totalAmount: number; // cents
    boardName: string; // breakfast/all-inclusive/etc.
  }>;
};

export type HotelSearchResult =
  | { ok: true; hotels: HotelOfferSummary[] }
  | { ok: false; error: string };

export async function searchHotels(
  input: HotelSearchInput,
): Promise<HotelSearchResult> {
  const apiKey = optionalEnv("HOTELBEDS_API_KEY");
  const secret = optionalEnv("HOTELBEDS_SECRET");
  if (!apiKey || !secret) {
    return { ok: false, error: "HOTELBEDS_API_KEY / HOTELBEDS_SECRET not set" };
  }
  if (input.adults < 1 || input.rooms < 1) {
    return { ok: false, error: "adults and rooms must be >= 1" };
  }

  const body = {
    stay: { checkIn: input.checkIn, checkOut: input.checkOut },
    occupancies: [
      {
        rooms: input.rooms,
        adults: input.adults,
        children: input.children ?? 0,
      },
    ],
    geolocation: {
      latitude: input.latitude,
      longitude: input.longitude,
      radius: input.radiusKm ?? 20,
      unit: "km",
    },
  };

  const url = `${HOTELBEDS_BASE}/hotel-api/1.0/hotels`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Api-key": apiKey,
        "X-Signature": signature(apiKey, secret),
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Capture body as text first so we can log the raw error response even if
  // Hotelbeds returns non-JSON (which they sometimes do on auth failures).
  const rawText = await res.text();
  let json: HotelbedsResponse = {};
  try {
    json = rawText ? (JSON.parse(rawText) as HotelbedsResponse) : {};
  } catch {
    // not JSON
  }

  if (!res.ok) {
    const msg =
      json.error?.message ?? `Hotelbeds ${res.status} ${res.statusText}`;
    // Log the full failure to the dev server console so the actual error
    // surfaces in `pnpm dev` output instead of being swallowed.
    console.error("[hotelbeds]", {
      status: res.status,
      statusText: res.statusText,
      url,
      apiKeyPrefix: apiKey.slice(0, 6) + "...",
      requestBody: body,
      responseBody: rawText.slice(0, 2000),
    });
    return { ok: false, error: msg };
  }
  if (!json.hotels?.hotels) {
    return { ok: true, hotels: [] };
  }

  const nights = nightsBetween(input.checkIn, input.checkOut);
  const cap = input.maxResults ?? 8;
  const hotels = json.hotels.hotels
    .map((h) => summarize(h, nights, input.rooms))
    .filter((h): h is HotelOfferSummary => h !== null)
    .sort((a, b) => a.minTotalAmount - b.minTotalAmount)
    .slice(0, cap);

  return { ok: true, hotels };
}

function signature(apiKey: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return createHash("sha256").update(`${apiKey}${secret}${ts}`).digest("hex");
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

function summarize(
  h: HotelbedsHotel,
  nights: number,
  rooms: number,
): HotelOfferSummary | null {
  if (!h.rooms?.length) return null;
  const allRates = h.rooms.flatMap((r) =>
    (r.rates ?? []).map((rate) => ({ room: r, rate })),
  );
  if (allRates.length === 0) return null;

  const cheapest = allRates.reduce((min, cur) =>
    parseAmount(cur.rate.net ?? cur.rate.sellingRate) <
    parseAmount(min.rate.net ?? min.rate.sellingRate)
      ? cur
      : min,
  );
  const minTotal = Math.round(
    parseAmount(cheapest.rate.net ?? cheapest.rate.sellingRate) * 100,
  );

  const refundable = allRates.some((r) => {
    const policies = r.rate.cancellationPolicies ?? [];
    return policies.length === 0 || policies.every((p) => parseAmount(p.amount) === 0);
  });

  return {
    hotelCode: h.code,
    name: h.name,
    categoryName: h.categoryName ?? "",
    zoneName: h.zoneName ?? null,
    destinationName: h.destinationName ?? null,
    minTotalAmount: minTotal,
    perNightPerRoomAmount: Math.round(minTotal / Math.max(1, nights * rooms)),
    currency: h.currency ?? "USD",
    refundable,
    rooms: h.rooms.slice(0, 3).map((r) => {
      const r0 = (r.rates ?? [])[0];
      return {
        name: r.name ?? "",
        rateType: r0?.rateType ?? "",
        totalAmount: r0
          ? Math.round(parseAmount(r0.net ?? r0.sellingRate) * 100)
          : 0,
        boardName: r0?.boardName ?? "",
      };
    }),
  };
}

function parseAmount(v: string | number | undefined): number {
  if (v == null) return Infinity;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : Infinity;
}

/* ---- Minimal Hotelbeds response types ---- */
type HotelbedsResponse = {
  hotels?: { hotels?: HotelbedsHotel[] };
  error?: { message?: string; code?: string };
};
type HotelbedsHotel = {
  code: number;
  name: string;
  categoryName?: string;
  zoneName?: string;
  destinationName?: string;
  currency?: string;
  rooms?: Array<{
    name?: string;
    rates?: Array<{
      rateType?: string;
      net?: string;
      sellingRate?: string;
      boardName?: string;
      cancellationPolicies?: Array<{ amount: string; from: string }>;
    }>;
  }>;
};

export function formatHotelOneLine(h: HotelOfferSummary): string {
  const perNight = (h.perNightPerRoomAmount / 100).toFixed(0);
  const total = (h.minTotalAmount / 100).toFixed(0);
  return `${h.name} (${h.categoryName.trim()}) — $${perNight}/rm/night, $${total} total · ${h.refundable ? "refundable" : "non-refundable"}`;
}
