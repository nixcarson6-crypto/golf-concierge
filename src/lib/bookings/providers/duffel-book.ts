/**
 * Real Duffel order creation. Takes an offer ID + passenger info and creates
 * an actual order via POST /air/orders. This is the "ticket it" step — what
 * makes the concierge book in-app rather than dump a link.
 *
 * Sandbox uses `type: "instant"` with `payments: [{ type: "balance" }]` which
 * draws from Duffel's test wallet. Production booking will need real
 * payment (Stripe via Duffel Payments or external card auth) — that's the
 * next iteration.
 */

import { optionalEnv } from "@/lib/env";

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

export type BookFlightPassenger = {
  given_name: string;
  family_name: string;
  born_on: string; // YYYY-MM-DD
  gender: "m" | "f";
  email: string;
  phone_number: string; // E.164 e.g. "+12125550100"
};

export type BookFlightInput = {
  offerId: string;
  passengers: BookFlightPassenger[];
};

export type BookFlightResult =
  | {
      ok: true;
      orderId: string;
      bookingReference: string;
      totalAmount: number; // cents
      currency: string;
      airline: string;
      passengers: number;
      slicesSummary: string;
    }
  | { ok: false; error: string };

type DuffelOffer = {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at: string;
  passengers: Array<{ id: string; type: string }>;
  owner: { name: string; iata_code: string };
  slices: Array<{
    origin: { iata_code: string };
    destination: { iata_code: string };
    duration: string;
  }>;
};

type DuffelOrder = {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
};

export async function bookFlightOffer(
  input: BookFlightInput,
): Promise<BookFlightResult> {
  const apiKey = optionalEnv("DUFFEL_API_KEY");
  if (!apiKey) return { ok: false, error: "DUFFEL_API_KEY not configured" };

  // Fetch the offer to get the canonical passenger IDs Duffel assigned + the
  // total to authorise. Offers expire fast (~5min) so this also validates.
  const offerRes = await fetch(`${DUFFEL_BASE}/air/offers/${input.offerId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Duffel-Version": DUFFEL_VERSION,
      Accept: "application/json",
    },
  });
  if (!offerRes.ok) {
    const txt = await offerRes.text().catch(() => "");
    if (offerRes.status === 404 || /expired/i.test(txt)) {
      return {
        ok: false,
        error:
          "That offer has expired (Duffel offers only last a few minutes). Re-search and confirm faster.",
      };
    }
    return { ok: false, error: `Couldn't fetch offer: ${offerRes.status}` };
  }
  const offerJson = (await offerRes.json()) as { data: DuffelOffer };
  const offer = offerJson.data;

  if (offer.passengers.length !== input.passengers.length) {
    return {
      ok: false,
      error: `Offer is for ${offer.passengers.length} passenger(s) but ${input.passengers.length} were supplied.`,
    };
  }

  const passengerPayload = offer.passengers.map((p, i) => ({
    id: p.id,
    title: input.passengers[i].gender === "m" ? "mr" : "ms",
    given_name: input.passengers[i].given_name,
    family_name: input.passengers[i].family_name,
    born_on: input.passengers[i].born_on,
    gender: input.passengers[i].gender,
    email: input.passengers[i].email,
    phone_number: input.passengers[i].phone_number,
  }));

  const orderRes = await fetch(`${DUFFEL_BASE}/air/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Duffel-Version": DUFFEL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "instant",
        selected_offers: [input.offerId],
        passengers: passengerPayload,
        payments: [
          {
            type: "balance",
            amount: offer.total_amount,
            currency: offer.total_currency,
          },
        ],
      },
    }),
  });

  if (!orderRes.ok) {
    const txt = await orderRes.text().catch(() => "");
    return {
      ok: false,
      error: `Booking rejected: ${txt.slice(0, 300)}`,
    };
  }

  const orderJson = (await orderRes.json()) as { data: DuffelOrder };
  const order = orderJson.data;

  const slicesSummary = offer.slices
    .map((s) => `${s.origin.iata_code}→${s.destination.iata_code}`)
    .join(" · ");

  return {
    ok: true,
    orderId: order.id,
    bookingReference: order.booking_reference,
    totalAmount: Math.round(parseFloat(order.total_amount) * 100),
    currency: order.total_currency,
    airline: offer.owner.name,
    passengers: offer.passengers.length,
    slicesSummary,
  };
}
