/**
 * Avis car rental booking. Real implementation against developer.avis.com
 * when AVIS_API_KEY is set; honest stub otherwise so the AI flow is
 * complete from day one.
 *
 * Avis production flow (simplified):
 *   1. POST /Rates — pickup airport + date range + driver age → rate quotes
 *   2. POST /Reservations — selected rate + driver info → confirmation
 */

import { optionalEnv } from "@/lib/env";
import { nanoid } from "nanoid";

const AVIS_BASE = "https://api.avis.com/v2"; // TODO confirm with partner docs

const CLASS_TO_AVIS_CODE: Record<string, string> = {
  economy: "ECAR",
  midsize: "ICAR",
  fullsize: "FCAR",
  luxury: "LCAR",
  suv: "SFAR",
  "luxury suv": "PFAR",
};

const CLASS_BASE_DAILY_CENTS: Record<string, number> = {
  economy: 4500,
  midsize: 6500,
  fullsize: 8500,
  luxury: 14500,
  suv: 11500,
  "luxury suv": 18500,
};

export type BookCarInput = {
  pickupAirport: string; // IATA
  pickupISO: string;
  returnISO: string;
  carClass: string;
  driverName: string;
  driverEmail: string;
};

export type BookCarResult =
  | {
      ok: true;
      bookingReference: string;
      providerReference: string;
      totalAmount: number; // cents
      currency: string;
      vendor: string;
      carClass: string;
      isStub: boolean;
    }
  | { ok: false; error: string };

export async function bookCar(input: BookCarInput): Promise<BookCarResult> {
  const apiKey = optionalEnv("AVIS_API_KEY");

  if (!apiKey) {
    return stubBooking(input);
  }

  const code =
    CLASS_TO_AVIS_CODE[input.carClass.toLowerCase()] ?? "ICAR";

  // Sketch of the real call — exact endpoint shape confirmed against the
  // partner docs once the key is provisioned.
  const body = {
    pickup: {
      location: input.pickupAirport,
      datetime: input.pickupISO,
    },
    return: {
      location: input.pickupAirport,
      datetime: input.returnISO,
    },
    carClass: code,
    driver: {
      name: input.driverName,
      email: input.driverEmail,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${AVIS_BASE}/reservations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Avis network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, error: `Avis rejected (${res.status}): ${txt.slice(0, 300)}` };
  }

  type AvisRes = {
    confirmationNumber?: string;
    reservationId?: string;
    totalAmount?: number;
    currency?: string;
  };
  const json = (await res.json().catch(() => ({}))) as AvisRes;

  return {
    ok: true,
    bookingReference: json.confirmationNumber ?? json.reservationId ?? "",
    providerReference: json.reservationId ?? "",
    totalAmount: Math.round((json.totalAmount ?? 0) * 100),
    currency: json.currency ?? "USD",
    vendor: "Avis",
    carClass: input.carClass,
    isStub: false,
  };
}

function stubBooking(input: BookCarInput): BookCarResult {
  const a = Date.parse(input.pickupISO);
  const b = Date.parse(input.returnISO);
  const days =
    Number.isNaN(a) || Number.isNaN(b) || b <= a
      ? 1
      : Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
  const dailyCents =
    CLASS_BASE_DAILY_CENTS[input.carClass.toLowerCase()] ?? 6500;
  const totalAmount = dailyCents * days;
  return {
    ok: true,
    bookingReference: `STUB-CAR-${nanoid(8).toUpperCase()}`,
    providerReference: `stub_${nanoid(10)}`,
    totalAmount,
    currency: "USD",
    vendor: "Avis",
    carClass: input.carClass,
    isStub: true,
  };
}
