/**
 * Lightspeed Golf (Chronogolf) partner-api booking. Real impl when
 * LIGHTSPEED_GOLF_API_KEY is set; honest stub otherwise so the AI flow
 * is complete from day one.
 *
 * Docs: https://partner-api.docs.chronogolf.com/
 */

import { optionalEnv } from "@/lib/env";
import { nanoid } from "nanoid";

const LIGHTSPEED_BASE = "https://api.chronogolf.com/partner";

export type BookTeeTimeInput = {
  courseName: string;
  teeOffISO: string; // local tee time in ISO
  players: number;
  greenFeePerPlayer: number; // cents
  leadPlayerName: string;
  leadPlayerEmail: string;
};

export type BookTeeTimeResult =
  | {
      ok: true;
      bookingReference: string;
      providerReference: string;
      totalAmount: number; // cents
      currency: string;
      courseName: string;
      isStub: boolean;
    }
  | { ok: false; error: string };

export async function bookTeeTime(input: BookTeeTimeInput): Promise<BookTeeTimeResult> {
  const apiKey = optionalEnv("LIGHTSPEED_GOLF_API_KEY");

  if (!apiKey) {
    return stubBooking(input);
  }

  // Real Lightspeed flow:
  //   1. Resolve course slug from name (search /courses)
  //   2. Find available tee time slot matching teeOffISO
  //   3. POST /reservations with players, slot id, lead player
  // For now we wire the minimal POST and surface clear errors. When the
  // key drops in, fill the search step out from the partner docs.
  const body = {
    course_name: input.courseName,
    tee_time: input.teeOffISO,
    players: input.players,
    lead_player: {
      name: input.leadPlayerName,
      email: input.leadPlayerEmail,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${LIGHTSPEED_BASE}/reservations`, {
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
      error: `Lightspeed Golf network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Lightspeed Golf rejected (${res.status}): ${txt.slice(0, 300)}`,
    };
  }

  type LSReservation = {
    id?: string;
    confirmation_code?: string;
    total_amount?: number;
    currency?: string;
  };
  const json = (await res.json().catch(() => ({}))) as LSReservation;
  return {
    ok: true,
    bookingReference: json.confirmation_code ?? json.id ?? "",
    providerReference: json.id ?? "",
    totalAmount: Math.round((json.total_amount ?? 0) * 100),
    currency: json.currency ?? "USD",
    courseName: input.courseName,
    isStub: false,
  };
}

function stubBooking(input: BookTeeTimeInput): BookTeeTimeResult {
  const totalAmount = input.greenFeePerPlayer * input.players;
  return {
    ok: true,
    bookingReference: `STUB-GOLF-${nanoid(8).toUpperCase()}`,
    providerReference: `stub_${nanoid(10)}`,
    totalAmount,
    currency: "USD",
    courseName: input.courseName,
    isStub: true,
  };
}
