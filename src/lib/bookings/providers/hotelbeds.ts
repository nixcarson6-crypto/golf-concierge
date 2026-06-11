/**
 * Hotelbeds (HBX Group APItude) — second hotel booking API, alongside LiteAPI.
 *
 * Flow: availability (by geolocation or hotel codes) → checkrates (only when
 * the rate is RECHECK) → book. Deep European + leisure-luxury inventory, so
 * it catches properties LiteAPI misses; the browser agent remains the final
 * fallback. Like LiteAPI, this is purely a BOOKING-METHOD optimization — the
 * itinerary AI picks hotels with zero knowledge of Hotelbeds coverage.
 *
 * Auth is per-request: an `Api-key` header plus an `X-Signature` header =
 * SHA-256 hex of (apiKey + secret + unix-seconds). The signature expires
 * fast, so it's computed fresh on every call.
 *
 * Hosts: api.test.hotelbeds.com (sandbox, default) / api.hotelbeds.com
 * (production) — switched by HOTELBEDS_ENV. `pnpm check:hotelbeds` runs the
 * full availability → book → cancel loop against the live sandbox so we can
 * correct any field drift before the app relies on it. Every call fails LOUD
 * (tagged error with the API's own message) — never a silent null.
 */

import { createHash } from "node:crypto";
import { env, optionalEnv } from "@/lib/env";

function baseUrl(): string {
  const mode = (optionalEnv("HOTELBEDS_ENV") ?? "test").toLowerCase();
  return mode === "production" || mode === "live"
    ? "https://api.hotelbeds.com"
    : "https://api.test.hotelbeds.com";
}

export function hotelbedsConfigured(): boolean {
  return Boolean(optionalEnv("HOTELBEDS_API_KEY") && optionalEnv("HOTELBEDS_SECRET"));
}

/** Per-request signature: SHA-256(apiKey + secret + unixSeconds), hex. */
function signature(apiKey: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return createHash("sha256").update(`${apiKey}${secret}${ts}`).digest("hex");
}

/** Raw fetch with signed auth + JSON, throwing a tagged error on any non-2xx. */
async function hbFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = env("HOTELBEDS_API_KEY");
  const secret = env("HOTELBEDS_SECRET");
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "Api-key": apiKey,
      "X-Signature": signature(apiKey, secret),
      Accept: "application/json",
      "Content-Type": "application/json",
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
    const j = json as { error?: { message?: string } | string; message?: string };
    const msg =
      (typeof j?.error === "object" ? j.error?.message : j?.error) ??
      j?.message ??
      text.slice(0, 240);
    throw new Error(`[hotelbeds] ${init?.method ?? "GET"} ${path} → ${res.status}: ${msg}`);
  }
  return json as T;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

export type HbRate = {
  rateKey: string;
  /** "BOOKABLE" books directly; "RECHECK" must pass through checkRates first. */
  rateType: string;
  /** Total net price for the stay, major units. */
  net: number | null;
  boardName: string | null;
  roomName: string | null;
};

export type HbHotel = {
  code: number;
  name: string;
  currency: string;
  /** All rates across all rooms, cheapest first. */
  rates: HbRate[];
};

/** Loose response shape — check:hotelbeds verifies the real nesting. */
type HbAvailabilityResponse = {
  hotels?: {
    hotels?: Array<{
      code?: number;
      name?: string;
      currency?: string;
      rooms?: Array<{
        name?: string;
        rates?: Array<{
          rateKey?: string;
          rateType?: string;
          net?: string | number;
          boardName?: string;
        }>;
      }>;
    }>;
  };
};

/**
 * Search live availability for the stay. Pass EITHER `geolocation` (lat/lng
 * + radius — how the booking path finds a named hotel without destination-
 * code mapping) OR explicit `hotelCodes`. Returns hotels with their rates
 * cheapest-first; empty array = Hotelbeds has nothing here.
 */
export async function searchAvailability(args: {
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  adults: number;
  geolocation?: { latitude: number; longitude: number; radiusKm?: number };
  hotelCodes?: number[];
}): Promise<HbHotel[]> {
  const body: Record<string, unknown> = {
    stay: { checkIn: args.checkIn, checkOut: args.checkOut },
    occupancies: [{ rooms: 1, adults: Math.max(1, args.adults), children: 0 }],
    ...(args.geolocation
      ? {
          geolocation: {
            latitude: args.geolocation.latitude,
            longitude: args.geolocation.longitude,
            radius: args.geolocation.radiusKm ?? 10,
            unit: "km",
          },
        }
      : {}),
    ...(args.hotelCodes?.length ? { hotels: { hotel: args.hotelCodes } } : {}),
  };
  const json = await hbFetch<HbAvailabilityResponse>("/hotel-api/1.0/hotels", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (json.hotels?.hotels ?? []).map((h) => {
    const rates: HbRate[] = [];
    for (const room of h.rooms ?? []) {
      for (const r of room.rates ?? []) {
        if (!r.rateKey) continue;
        const net = r.net != null ? Number(r.net) : null;
        rates.push({
          rateKey: r.rateKey,
          rateType: r.rateType ?? "BOOKABLE",
          net: Number.isFinite(net) ? net : null,
          boardName: r.boardName ?? null,
          roomName: room.name ?? null,
        });
      }
    }
    rates.sort((a, b) => (a.net ?? Infinity) - (b.net ?? Infinity));
    return {
      code: h.code ?? 0,
      name: h.name ?? "(unnamed)",
      currency: h.currency ?? "EUR",
      rates,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Name matching (same distinctive-token rule as LiteAPI's resolver)           */
/* -------------------------------------------------------------------------- */

// Duplicated from providers/liteapi.ts on purpose — both modules stay leaf
// (no cross-provider import) so either can be ripped out without breaking
// the other. A real match needs a DISTINCTIVE shared token, so "Comfort Inn"
// can't masquerade as "Inn at Spanish Bay".
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

/**
 * Find the availability hotel matching a venue name. Returns the best match
 * by distinctive shared tokens, or null when Hotelbeds doesn't carry the
 * property → caller falls back to the next provider / browser agent.
 */
export function matchHotelByName(hotels: HbHotel[], name: string): HbHotel | null {
  // Strip a trailing room/suite descriptor ("Splendido — Belmond Suite").
  const cleanName = name.split(/[—–-]/)[0]?.trim() || name;
  const wanted = nameTokens(cleanName);
  if (wanted.size === 0) return null;
  let best: HbHotel | null = null;
  let bestScore = 0;
  for (const h of hotels) {
    const have = nameTokens(h.name);
    let shared = 0;
    for (const t of wanted) if (have.has(t)) shared++;
    if (shared > bestScore) {
      bestScore = shared;
      best = h;
    }
  }
  return bestScore >= 1 ? best : null;
}

/* -------------------------------------------------------------------------- */
/* CheckRates (revalidate a RECHECK rate before booking)                       */
/* -------------------------------------------------------------------------- */

export type HbCheckedRate = { rateKey: string; net: number | null; currency: string };

/** Revalidate a RECHECK rateKey; returns the fresh bookable rateKey + price. */
export async function checkRate(rateKey: string): Promise<HbCheckedRate> {
  const json = await hbFetch<{
    hotel?: {
      currency?: string;
      totalNet?: string | number;
      rooms?: Array<{ rates?: Array<{ rateKey?: string; net?: string | number }> }>;
    };
  }>("/hotel-api/1.0/checkrates", {
    method: "POST",
    body: JSON.stringify({ rooms: [{ rateKey }] }),
  });
  const fresh = json.hotel?.rooms?.[0]?.rates?.[0];
  if (!fresh?.rateKey) throw new Error("[hotelbeds] checkrates returned no rateKey");
  const net = fresh.net != null ? Number(fresh.net) : json.hotel?.totalNet != null ? Number(json.hotel.totalNet) : null;
  return {
    rateKey: fresh.rateKey,
    net: Number.isFinite(net) ? net : null,
    currency: json.hotel?.currency ?? "EUR",
  };
}

/* -------------------------------------------------------------------------- */
/* Book + cancel                                                               */
/* -------------------------------------------------------------------------- */

export type HbBooking = {
  reference: string;
  status: string;
  totalNet: number | null;
  currency: string;
};

/**
 * Complete the booking against a BOOKABLE rateKey. Test environment books
 * against the account's sandbox credit line — no card needed (the merchant
 * model: Hotelbeds invoices us, we charge the customer via Stripe).
 */
export async function book(args: {
  rateKey: string;
  holder: { firstName: string; lastName: string };
  adults: number;
  /** Our own reference so the booking is traceable in their extranet. */
  clientReference: string;
  remark?: string;
}): Promise<HbBooking> {
  const paxes = Array.from({ length: Math.max(1, args.adults) }, (_, i) => ({
    roomId: 1,
    type: "AD",
    name: i === 0 ? args.holder.firstName : "Guest",
    surname: args.holder.lastName,
  }));
  const json = await hbFetch<{
    booking?: {
      reference?: string;
      status?: string;
      totalNet?: string | number;
      currency?: string;
    };
  }>("/hotel-api/1.0/bookings", {
    method: "POST",
    body: JSON.stringify({
      holder: { name: args.holder.firstName, surname: args.holder.lastName },
      rooms: [{ rateKey: args.rateKey, paxes }],
      clientReference: args.clientReference.slice(0, 20),
      ...(args.remark ? { remark: args.remark.slice(0, 200) } : {}),
      tolerance: 2, // accept ≤2% price drift between checkrates and book
    }),
  });
  const b = json.booking ?? {};
  if (!b.reference) throw new Error("[hotelbeds] book returned no reference");
  const net = b.totalNet != null ? Number(b.totalNet) : null;
  return {
    reference: b.reference,
    status: b.status ?? "unknown",
    totalNet: Number.isFinite(net) ? net : null,
    currency: b.currency ?? "EUR",
  };
}

/** Cancel a booking (used by check:hotelbeds so sandbox tests clean up). */
export async function cancelBooking(reference: string): Promise<string> {
  const json = await hbFetch<{ booking?: { status?: string } }>(
    `/hotel-api/1.0/bookings/${encodeURIComponent(reference)}?cancellationFlag=CANCELLATION`,
    { method: "DELETE" },
  );
  return json.booking?.status ?? "unknown";
}
