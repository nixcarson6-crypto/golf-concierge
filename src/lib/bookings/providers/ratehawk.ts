/**
 * RateHawk (Emerging Travel Group) — third hotel booking API in the chain
 * (LiteAPI → Hotelbeds → RateHawk → browser agent).
 *
 * Built DARK ahead of credentials (Elsa/ETG enabling API access): the code
 * sits inert until RATEHAWK_KEY_ID + RATEHAWK_API_KEY land in .env.local,
 * then `pnpm check:ratehawk` validates the real response shapes against
 * these assumptions — same wire-then-verify pattern that landed LiteAPI and
 * Hotelbeds. Every call fails LOUD with ETG's own error body.
 *
 * ETG B2B API v3 (api.worldota.net), HTTP Basic auth (key_id:api_key).
 * Flow: geo search (lat/lng radius) → match hotel by name → hotelpage
 * (rates with book_hash) → booking form → booking finish. Booking finish
 * is asynchronous on ETG's side; v1 treats "finish accepted" + status poll
 * as confirmation and otherwise falls through to the agent.
 */

import { env, optionalEnv } from "@/lib/env";

const BASE = "https://api.worldota.net/api/b2b/v3";

export function ratehawkConfigured(): boolean {
  return Boolean(optionalEnv("RATEHAWK_KEY_ID") && optionalEnv("RATEHAWK_API_KEY"));
}

function authHeader(): string {
  const id = env("RATEHAWK_KEY_ID").trim();
  const key = env("RATEHAWK_API_KEY").trim();
  return `Basic ${Buffer.from(`${id}:${key}`).toString("base64")}`;
}

/** ETG wraps every response as { status, data, error }. Non-"ok" → throw. */
async function rhFetch<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: { status?: string; data?: T; error?: unknown };
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { status: "error", error: text.slice(0, 300) };
  }
  if (!res.ok || json.status !== "ok") {
    throw new Error(
      `[ratehawk] POST ${path} → ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 300)}`,
    );
  }
  return json.data as T;
}

/* ----------------------------- search + match ----------------------------- */

export type RhHotel = {
  id: string;
  name: string;
  /** Cheapest rate's book_hash + total, major units. */
  bookHash: string | null;
  total: number | null;
  currency: string;
};

type RhRawRate = {
  book_hash?: string;
  payment_options?: {
    payment_types?: Array<{
      amount?: string;
      show_amount?: string;
      currency_code?: string;
      show_currency_code?: string;
      type?: string;
    }>;
  };
};
type RhRawHotel = { id?: string; hid?: number; rates?: RhRawRate[] };

function summarize(h: RhRawHotel): RhHotel {
  let bookHash: string | null = null;
  let total: number | null = null;
  let currency = "USD";
  for (const r of h.rates ?? []) {
    const pt = r.payment_options?.payment_types?.[0];
    const amt = pt?.show_amount ?? pt?.amount;
    const n = amt != null ? Number(amt) : null;
    if (r.book_hash && n != null && Number.isFinite(n) && (total == null || n < total)) {
      bookHash = r.book_hash;
      total = n;
      currency = pt?.show_currency_code ?? pt?.currency_code ?? currency;
    }
  }
  // ETG hotel ids are slugs ("rixos_premium_dubai"); name is derived from
  // the slug here — the static-content endpoint can pretty it up later.
  const id = String(h.id ?? h.hid ?? "");
  return {
    id,
    name: id.replace(/_/g, " "),
    bookHash,
    total,
    currency,
  };
}

/** Region-free availability: hotels with rates within `radiusM` of a point. */
export async function searchByGeo(args: {
  checkin: string; // YYYY-MM-DD
  checkout: string;
  adults: number;
  latitude: number;
  longitude: number;
  radiusM?: number;
  currency?: string;
  residency?: string;
}): Promise<RhHotel[]> {
  const data = await rhFetch<{ hotels?: RhRawHotel[] }>("/search/serp/geo/", {
    checkin: args.checkin,
    checkout: args.checkout,
    residency: args.residency ?? "us",
    language: "en",
    guests: [{ adults: Math.max(1, args.adults), children: [] }],
    longitude: args.longitude,
    latitude: args.latitude,
    radius: args.radiusM ?? 5000,
    currency: args.currency ?? "USD",
  });
  return (data.hotels ?? []).map(summarize);
}

// Same distinctive-token matcher as the other providers (duplicated on
// purpose — leaf modules). ETG ids are slugs, so matching runs on the
// de-slugged name.
const GENERIC = new Set([
  "the","a","an","and","by","at","of","hotel","hotels","resort","resorts",
  "spa","inn","lodge","suites","suite","collection","golf","club","country",
  "house","grand","palace","villa","rooms","place",
]);
function tokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter((t) => t.length > 3 && !GENERIC.has(t)),
  );
}

export function matchByName(hotels: RhHotel[], wantedName: string): RhHotel | null {
  const clean = wantedName.split(/[—–-]/)[0]?.trim() || wantedName;
  const wanted = tokens(clean);
  if (wanted.size === 0) return null;
  let best: RhHotel | null = null;
  let bestScore = 0;
  for (const h of hotels) {
    const have = tokens(h.name);
    let shared = 0;
    for (const t of wanted) if (have.has(t)) shared++;
    if (shared > bestScore) {
      bestScore = shared;
      best = h;
    }
  }
  return bestScore >= 1 ? best : null;
}

/* --------------------------------- booking -------------------------------- */

export type RhBooking = {
  orderId: string;
  status: string;
};

/**
 * Book a rate by its book_hash: booking form → finish → one status poll.
 * ETG's finish is async; "ok" + a non-failed status is treated as accepted.
 * Any error throws and the chain falls through to the browser agent.
 */
export async function bookByHash(args: {
  bookHash: string;
  partnerOrderId: string;
  holder: { firstName: string; lastName: string; email: string; phone: string };
  adults: number;
}): Promise<RhBooking> {
  const form = await rhFetch<{
    order_id?: number;
    item_id?: number;
    payment_types?: Array<{ type?: string; amount?: string; currency_code?: string }>;
  }>("/hotel/order/booking/form/", {
    partner_order_id: args.partnerOrderId.slice(0, 64),
    book_hash: args.bookHash,
    language: "en",
    user_ip: "127.0.0.1",
  });
  const orderId = String(form.order_id ?? "");
  if (!orderId) throw new Error("[ratehawk] booking form returned no order_id");

  const payType = form.payment_types?.[0];
  await rhFetch("/hotel/order/booking/finish/", {
    partner: { partner_order_id: args.partnerOrderId.slice(0, 64) },
    language: "en",
    rooms: [
      {
        guests: Array.from({ length: Math.max(1, args.adults) }, (_, i) => ({
          first_name: i === 0 ? args.holder.firstName : "Guest",
          last_name: args.holder.lastName,
        })),
      },
    ],
    user: { email: args.holder.email, phone: args.holder.phone || "+10000000000" },
    payment_type: payType ?? { type: "deposit" },
  });

  // One status check; ETG processes asynchronously.
  const status = await rhFetch<{ status?: string }>(
    "/hotel/order/booking/finish/status/",
    { partner_order_id: args.partnerOrderId.slice(0, 64) },
  ).catch(() => ({ status: "processing" }));

  return { orderId, status: status.status ?? "processing" };
}
