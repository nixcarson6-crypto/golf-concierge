/**
 * Real Duffel flight search. Thin wrapper around POST /air/offer_requests with
 * return_offers=true so we can search and get offers in a single round trip.
 *
 * We don't hold or ticket here — that's the booking-executor's job, gated by
 * an explicit human confirmation in chat. This module is the read-only "find
 * me what's out there" surface that the concierge tool calls when the user is
 * asking about flights.
 */

import { optionalEnv } from "@/lib/env";

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

export type FlightSlice = {
  origin: string; // IATA code, e.g. "DFW"
  destination: string; // IATA, e.g. "COS"
  departureDate: string; // ISO date "YYYY-MM-DD"
};

export type CabinClass =
  | "economy"
  | "premium_economy"
  | "business"
  | "first";

export type FlightSearchInput = {
  slices: FlightSlice[];
  passengers: number; // adults; minors not yet supported
  cabin?: CabinClass;
  /** Cap how many offers we ask Duffel to return. */
  maxOffers?: number;
};

export type FlightOfferSummary = {
  id: string;
  totalAmount: number; // cents
  currency: string;
  perPassengerAmount: number; // cents
  airlineName: string;
  airlineIataCode: string;
  slices: Array<{
    origin: string;
    destination: string;
    departing: string; // ISO datetime
    arriving: string; // ISO datetime
    durationMinutes: number;
    stops: number;
    cabin: string;
    segments: Array<{
      flightNumber: string;
      origin: string;
      destination: string;
      departing: string;
      arriving: string;
    }>;
  }>;
  // Bookable until — Duffel expires offers fairly quickly.
  expiresAt: string | null;
};

export type FlightSearchResult = {
  ok: true;
  offers: FlightOfferSummary[];
  /** Duffel offer_request id — we keep this to ticket later. */
  offerRequestId: string;
} | {
  ok: false;
  error: string;
};

export async function searchFlights(
  input: FlightSearchInput,
): Promise<FlightSearchResult> {
  const apiKey = optionalEnv("DUFFEL_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "DUFFEL_API_KEY not configured" };
  }
  if (input.slices.length === 0) {
    return { ok: false, error: "at least one slice is required" };
  }
  if (input.passengers < 1 || input.passengers > 9) {
    return { ok: false, error: "passengers must be between 1 and 9" };
  }

  const body = {
    data: {
      slices: input.slices.map((s) => ({
        origin: s.origin.toUpperCase(),
        destination: s.destination.toUpperCase(),
        departure_date: s.departureDate,
      })),
      passengers: Array.from({ length: input.passengers }, () => ({
        type: "adult" as const,
      })),
      cabin_class: input.cabin ?? "economy",
    },
  };

  const url = `${DUFFEL_BASE}/air/offer_requests?return_offers=true`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Duffel-Version": DUFFEL_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const json = (await res.json().catch(() => ({}))) as DuffelOfferRequestResponse;
  if (!res.ok) {
    const msg =
      json.errors?.[0]?.message ?? `Duffel returned ${res.status}`;
    return { ok: false, error: msg };
  }
  if (!json.data) {
    return { ok: false, error: "Duffel response missing data" };
  }

  const cap = input.maxOffers ?? 5;
  const offers = (json.data.offers ?? [])
    .slice()
    .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
    .slice(0, cap)
    .map(summarizeOffer)
    .filter((o): o is FlightOfferSummary => o !== null);

  return { ok: true, offerRequestId: json.data.id, offers };
}

function summarizeOffer(o: DuffelOffer): FlightOfferSummary | null {
  if (!o.slices?.length) return null;
  const totalDollars = Number(o.total_amount);
  if (Number.isNaN(totalDollars)) return null;
  const totalCents = Math.round(totalDollars * 100);
  const paxCount = o.passengers?.length || 1;

  return {
    id: o.id,
    totalAmount: totalCents,
    currency: o.total_currency || "USD",
    perPassengerAmount: Math.round(totalCents / paxCount),
    airlineName: o.owner?.name ?? "Unknown",
    airlineIataCode: o.owner?.iata_code ?? "",
    expiresAt: o.expires_at ?? null,
    slices: o.slices.map((s) => ({
      origin: s.origin?.iata_code ?? "",
      destination: s.destination?.iata_code ?? "",
      departing: s.segments?.[0]?.departing_at ?? "",
      arriving: s.segments?.[s.segments.length - 1]?.arriving_at ?? "",
      durationMinutes: parseDuration(s.duration ?? ""),
      stops: Math.max(0, (s.segments?.length ?? 1) - 1),
      cabin: s.segments?.[0]?.passengers?.[0]?.cabin_class ?? "",
      segments: (s.segments ?? []).map((seg) => ({
        flightNumber: `${seg.marketing_carrier?.iata_code ?? ""}${seg.marketing_carrier_flight_number ?? ""}`,
        origin: seg.origin?.iata_code ?? "",
        destination: seg.destination?.iata_code ?? "",
        departing: seg.departing_at ?? "",
        arriving: seg.arriving_at ?? "",
      })),
    })),
  };
}

/** Duffel returns ISO-8601 durations like "PT1H50M". Convert to total minutes. */
function parseDuration(d: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  if (!m) return 0;
  const hours = m[1] ? parseInt(m[1], 10) : 0;
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + mins;
}

/* -------------------------------------------------------------------------- */
/* Minimal Duffel response types — only the fields we actually read.          */
/* -------------------------------------------------------------------------- */

type DuffelOfferRequestResponse = {
  data?: {
    id: string;
    offers?: DuffelOffer[];
  };
  errors?: Array<{ message: string; code?: string }>;
};

type DuffelOffer = {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at?: string;
  owner?: { name?: string; iata_code?: string };
  passengers?: Array<unknown>;
  slices: Array<{
    origin?: { iata_code?: string };
    destination?: { iata_code?: string };
    duration?: string;
    segments?: Array<{
      origin?: { iata_code?: string };
      destination?: { iata_code?: string };
      departing_at?: string;
      arriving_at?: string;
      marketing_carrier?: { iata_code?: string };
      marketing_carrier_flight_number?: string;
      passengers?: Array<{ cabin_class?: string }>;
    }>;
  }>;
};

/** Format a single offer as a one-line chat-friendly summary. */
export function formatOfferOneLine(o: FlightOfferSummary): string {
  const slice0 = o.slices[0];
  if (!slice0) return `${o.airlineName} · $${(o.totalAmount / 100).toFixed(0)} total`;
  const dollars = (o.perPassengerAmount / 100).toFixed(0);
  const stops = slice0.stops === 0 ? "nonstop" : `${slice0.stops} stop`;
  const dur = `${Math.floor(slice0.durationMinutes / 60)}h ${slice0.durationMinutes % 60}m`;
  return `${o.airlineName} ${slice0.origin}-${slice0.destination} ${stops}, ${dur} · $${dollars}/pax (${o.slices[0].cabin})`;
}
