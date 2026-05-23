/**
 * Uber Guest Rides — book a ride on behalf of a customer who doesn't
 * have an Uber account. Used by Pyltrix's ground-transport flow: the
 * customer picks "Uber" in the quiz, the itinerary generates per-leg
 * transfers (airport → hotel, hotel → course, etc.), and at trip
 * Book-All time we request real Ubers on their behalf via this API.
 *
 * Auth: OAuth 2.0 client_credentials grant. We cache the access token
 * in-process for its full TTL minus 60 s so we're not minting a new
 * token on every request.
 *
 * Sandbox vs production: same code paths. UBER_ENV=sandbox (the
 * default) points at sandbox-api.uber.com and tolerates a placeholder
 * org UUID; UBER_ENV=production points at api.uber.com and requires
 * the real Uber for Business organization UUID granted on Central API
 * approval.
 *
 * Honest stub fallback: if UBER_CLIENT_ID isn't set, every call returns
 * { ok: false, error: "...not configured" } — never a fake confirmation.
 */

import { optionalEnv } from "@/lib/env";

type UberEnvironment = "sandbox" | "production";

function uberEnv(): UberEnvironment {
  const raw = (optionalEnv("UBER_ENV") ?? "sandbox").toLowerCase();
  return raw === "production" ? "production" : "sandbox";
}

function authBase(): string {
  // Auth is the same endpoint regardless of api environment.
  return "https://auth.uber.com";
}

function apiBase(): string {
  return uberEnv() === "production"
    ? "https://api.uber.com"
    : "https://sandbox-api.uber.com";
}

/* -------------------------------------------------------------------------- */
/* Access token cache                                                          */
/* -------------------------------------------------------------------------- */

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<
  { ok: true; token: string } | { ok: false; error: string }
> {
  const clientId = optionalEnv("UBER_CLIENT_ID");
  const clientSecret = optionalEnv("UBER_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error:
        "UBER_CLIENT_ID / UBER_CLIENT_SECRET not configured in .env.local",
    };
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return { ok: true, token: cachedToken.value };
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "guests.trips",
  });

  let res: Response;
  try {
    res = await fetch(`${authBase()}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Uber auth network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Uber auth rejected (${res.status}): ${text.slice(0, 280)}`,
    };
  }

  type TokenRes = {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const json = (await res.json().catch(() => ({}))) as TokenRes;
  if (!json.access_token) {
    return { ok: false, error: "Uber returned no access_token" };
  }

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return { ok: true, token: cachedToken.value };
}

/* -------------------------------------------------------------------------- */
/* Estimates                                                                   */
/* -------------------------------------------------------------------------- */

export type RideEstimateInput = {
  pickup: { latitude: number; longitude: number };
  dropoff: { latitude: number; longitude: number };
};

export type RideEstimate = {
  productId: string;
  productName: string; // "UberX", "Black", "LUX", etc.
  fareLow: number; // cents
  fareHigh: number; // cents
  currency: string;
  pickupEtaSeconds: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
};

export type EstimateResult =
  | { ok: true; estimates: RideEstimate[] }
  | { ok: false; error: string };

/**
 * GET /v1/guests/trips/estimates — returns fare ranges + ETAs for every
 * product available between the pickup and dropoff. Used to surface
 * "Uber Black ~$78 · 5 min ETA" on the itinerary transport cards.
 */
export async function estimateRide(
  input: RideEstimateInput,
): Promise<EstimateResult> {
  const tokenRes = await getAccessToken();
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error };

  const params = new URLSearchParams({
    pickup_latitude: String(input.pickup.latitude),
    pickup_longitude: String(input.pickup.longitude),
    dropoff_latitude: String(input.dropoff.latitude),
    dropoff_longitude: String(input.dropoff.longitude),
  });

  let res: Response;
  try {
    res = await fetch(
      `${apiBase()}/v1/guests/trips/estimates?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${tokenRes.token}`,
          Accept: "application/json",
        },
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: `Uber estimate network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Uber estimate rejected (${res.status}): ${text.slice(0, 280)}`,
    };
  }

  type EstimateRow = {
    product_id?: string;
    display_name?: string;
    fare_breakdown?: { value?: number; type?: string };
    high_estimate?: number;
    low_estimate?: number;
    currency_code?: string;
    pickup_estimate?: number; // minutes
    distance?: number;
    duration?: number;
  };
  type EstimateResponse = { estimates?: EstimateRow[] };
  const json = (await res.json().catch(() => ({}))) as EstimateResponse;

  const estimates: RideEstimate[] = (json.estimates ?? []).map((r) => ({
    productId: r.product_id ?? "",
    productName: r.display_name ?? "Uber",
    fareLow: Math.round((r.low_estimate ?? 0) * 100),
    fareHigh: Math.round((r.high_estimate ?? 0) * 100),
    currency: r.currency_code ?? "USD",
    pickupEtaSeconds: r.pickup_estimate != null ? r.pickup_estimate * 60 : null,
    distanceMeters: r.distance != null ? Math.round(r.distance * 1609.34) : null,
    durationSeconds: r.duration ?? null,
  }));

  return { ok: true, estimates };
}

/* -------------------------------------------------------------------------- */
/* Trip creation                                                               */
/* -------------------------------------------------------------------------- */

export type CreateRideInput = {
  productId: string;
  pickup: { latitude: number; longitude: number; address?: string };
  dropoff: { latitude: number; longitude: number; address?: string };
  guest: {
    firstName: string;
    lastName: string;
    phoneNumber: string; // E.164
    email?: string;
    locale?: string; // "en_US"
  };
  // Schedule for later (ISO datetime in UTC) — omit for on-demand.
  scheduleAtIso?: string;
};

export type CreateRideResult =
  | {
      ok: true;
      requestId: string;
      status: string; // "processing" | "scheduled" | "accepted" | ...
      productId: string;
      pickupEtaSeconds: number | null;
      isSandbox: boolean;
    }
  | { ok: false; error: string };

/**
 * POST /v1/guests/trips — creates a Guest Rides trip for the named
 * passenger. The pickup_at field switches between on-demand and
 * scheduled rides. Sandbox returns a fake trip; production dispatches
 * a real driver.
 */
export async function createGuestRide(
  input: CreateRideInput,
): Promise<CreateRideResult> {
  const tokenRes = await getAccessToken();
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error };

  const orgUuid = optionalEnv("UBER_ORG_UUID");
  const isSandbox = uberEnv() === "sandbox";
  // Production requires a real org UUID; sandbox tolerates a placeholder
  // so we can dev the full flow before U4B Central API approval lands.
  if (!isSandbox && !orgUuid) {
    return {
      ok: false,
      error:
        "UBER_ORG_UUID is required for production. Get it from your U4B account after Central API approval.",
    };
  }

  const body: Record<string, unknown> = {
    product_id: input.productId,
    pickup: {
      latitude: input.pickup.latitude,
      longitude: input.pickup.longitude,
      ...(input.pickup.address ? { address: input.pickup.address } : {}),
    },
    dropoff: {
      latitude: input.dropoff.latitude,
      longitude: input.dropoff.longitude,
      ...(input.dropoff.address ? { address: input.dropoff.address } : {}),
    },
    guest: {
      first_name: input.guest.firstName,
      last_name: input.guest.lastName,
      phone_number: input.guest.phoneNumber,
      ...(input.guest.email ? { email: input.guest.email } : {}),
      locale: input.guest.locale ?? "en_US",
    },
    ...(input.scheduleAtIso ? { pickup_at: input.scheduleAtIso } : {}),
  };
  if (orgUuid) body.org_uuid = orgUuid;

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/v1/guests/trips`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenRes.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Uber trip create network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Uber trip create rejected (${res.status}): ${text.slice(0, 280)}`,
    };
  }

  type TripRes = {
    request_id?: string;
    status?: string;
    product_id?: string;
    pickup?: { eta?: number };
  };
  const json = (await res.json().catch(() => ({}))) as TripRes;
  if (!json.request_id) {
    return { ok: false, error: "Uber returned no request_id" };
  }

  return {
    ok: true,
    requestId: json.request_id,
    status: json.status ?? "processing",
    productId: json.product_id ?? input.productId,
    pickupEtaSeconds:
      json.pickup?.eta != null ? json.pickup.eta * 60 : null,
    isSandbox,
  };
}

/** Public helper so callers can branch UI on "have we configured Uber yet?" */
export function uberConfigured(): boolean {
  return Boolean(optionalEnv("UBER_CLIENT_ID") && optionalEnv("UBER_CLIENT_SECRET"));
}
