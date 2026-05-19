/**
 * Hotelbeds booking endpoint. Real implementation hits POST
 * /hotel-api/1.0/bookings with the rateKey returned by search. Falls back
 * to a realistic stub when API credentials are absent so the AI flow works
 * end-to-end before approval arrives.
 *
 * The same signed-auth pattern as hotelbeds-search is used.
 */

import { createHash } from "crypto";
import { optionalEnv } from "@/lib/env";
import { nanoid } from "nanoid";

const HOTELBEDS_BASE = "https://api.test.hotelbeds.com";

export type HotelGuest = {
  name: string;
  surname: string;
};

export type BookHotelInput = {
  rateKey: string;
  hotelName: string; // for echo + stub fallback
  city: string | null;
  checkIn: string; // YYYY-MM-DD
  checkOut: string;
  rooms: number;
  guests: HotelGuest[]; // length === rooms (lead guest per room)
  holderName: string;
  holderSurname: string;
  holderEmail: string;
};

export type BookHotelResult =
  | {
      ok: true;
      bookingReference: string;
      providerReference: string;
      totalAmount: number; // cents
      currency: string;
      hotelName: string;
      isStub: boolean;
    }
  | { ok: false; error: string };

export async function bookHotel(input: BookHotelInput): Promise<BookHotelResult> {
  const apiKey = optionalEnv("HOTELBEDS_API_KEY");
  const secret = optionalEnv("HOTELBEDS_SECRET");

  if (!apiKey || !secret) {
    return stubBooking(input);
  }

  const ts = Math.floor(Date.now() / 1000);
  const sig = createHash("sha256")
    .update(`${apiKey}${secret}${ts}`)
    .digest("hex");

  const holderRooms = input.guests.slice(0, input.rooms).map((g) => ({
    rateKey: input.rateKey,
    paxes: [
      {
        roomId: 1,
        type: "AD",
        name: g.name,
        surname: g.surname,
      },
    ],
  }));

  const body = {
    holder: {
      name: input.holderName,
      surname: input.holderSurname,
    },
    clientReference: `gc_${nanoid(10)}`,
    remark: "Booked via Golf Concierge",
    rooms: holderRooms,
  };

  let res: Response;
  try {
    res = await fetch(`${HOTELBEDS_BASE}/hotel-api/1.0/bookings`, {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "X-Signature": sig,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Hotelbeds network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Hotelbeds rejected booking (${res.status}): ${txt.slice(0, 300)}`,
    };
  }

  type HotelbedsBookingResponse = {
    booking?: {
      reference: string;
      clientReference: string;
      totalNet?: number;
      pendingAmount?: number;
      currency?: string;
      hotel?: { name: string };
    };
  };
  const json = (await res.json().catch(() => ({}))) as HotelbedsBookingResponse;
  const b = json.booking;
  if (!b) {
    return { ok: false, error: "Hotelbeds returned no booking payload" };
  }
  return {
    ok: true,
    bookingReference: b.reference,
    providerReference: b.clientReference,
    totalAmount: Math.round((b.totalNet ?? 0) * 100),
    currency: b.currency ?? "USD",
    hotelName: b.hotel?.name ?? input.hotelName,
    isStub: false,
  };
}

function stubBooking(input: BookHotelInput): BookHotelResult {
  // Realistic stub: ~$280/night × nights × rooms baseline. Keeps the AI flow
  // honest with totals that don't look absurd.
  const a = Date.parse(input.checkIn);
  const b = Date.parse(input.checkOut);
  const nights =
    Number.isNaN(a) || Number.isNaN(b) || b <= a
      ? 1
      : Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
  const totalAmount = Math.round(280 * 100 * nights * input.rooms);
  return {
    ok: true,
    bookingReference: `STUB-HTL-${nanoid(8).toUpperCase()}`,
    providerReference: `stub_${nanoid(10)}`,
    totalAmount,
    currency: "USD",
    hotelName: input.hotelName,
    isStub: true,
  };
}
