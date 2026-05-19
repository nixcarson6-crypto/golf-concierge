/**
 * Duffel API partner for flights. Real search via Duffel REST API; hold +
 * confirm still stubbed pending the booking flow being wired end-to-end
 * (depends on a separate human-confirmation step before we ticket).
 */

import { nanoid } from "nanoid";
import type {
  BookingPartner,
  BookingQuote,
  BookingResult,
} from "../types";
import { searchFlights } from "./duffel-search";

export const duffelPartner: BookingPartner = {
  provider: "DUFFEL",
  supports: ["FLIGHT"],
  isConfigured: () => Boolean(process.env.DUFFEL_API_KEY),
  supportsHold: true,
  defaultHoldMinutes: 30,
  cancellationPolicy:
    "Per airline. We surface the offer's fare conditions before charging.",

  async search(req) {
    // The booking executor currently passes generic request fields and not
    // structured slice/passenger data. Until we wire the executor to feed
    // origin/destination/dates, fall back to a sentinel quote so the rest of
    // the pipeline doesn't break. Live chat flight queries go through the
    // top-level `searchFlights` helper directly.
    const origin = (req.metadata?.origin as string | undefined) ?? null;
    const destination = (req.metadata?.destination as string | undefined) ?? null;
    const departureDate =
      (req.metadata?.departureDate as string | undefined) ??
      req.startTime?.toISOString().slice(0, 10) ??
      null;
    const passengers = req.party ?? 1;

    if (origin && destination && departureDate) {
      const result = await searchFlights({
        slices: [{ origin, destination, departureDate }],
        passengers,
        cabin: (req.metadata?.cabin as
          | "economy"
          | "premium_economy"
          | "business"
          | "first"
          | undefined) ?? "economy",
        maxOffers: 3,
      });
      if (result.ok && result.offers.length > 0) {
        return result.offers.map((o) => ({
          provider: "DUFFEL" as const,
          providerReference: o.id,
          cost: o.totalAmount,
          currency: o.currency,
          expiresAt: o.expiresAt ? new Date(o.expiresAt) : undefined,
          raw: o,
        }));
      }
    }

    return [
      {
        provider: "DUFFEL",
        providerReference: `df_offer_${nanoid(10)}`,
        cost: req.budget ?? 60000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 20 * 60 * 1000),
      },
    ] satisfies BookingQuote[];
  },

  async quote(req) {
    return (await this.search(req))[0];
  },

  async hold(_req, quote): Promise<BookingResult> {
    return {
      provider: "DUFFEL",
      providerReference: `df_hold_${nanoid(12)}`,
      confirmationCode: `DF-HOLD-${nanoid(5).toUpperCase()}`,
      cost: quote.cost,
      currency: quote.currency,
      status: "HELD",
      heldUntil: new Date(Date.now() + 30 * 60 * 1000),
    };
  },

  async confirm(providerReference): Promise<BookingResult> {
    return {
      provider: "DUFFEL",
      providerReference,
      confirmationCode: `DF-${nanoid(8).toUpperCase()}`,
      cost: 0,
      currency: "USD",
      status: "CONFIRMED",
    };
  },

  async book(req): Promise<BookingResult> {
    const q = await this.quote(req);
    const h = await this.hold!(req, q);
    return this.confirm!(h.providerReference);
  },

  async cancel() {
    return;
  },

  async getStatus() {
    return { status: "CONFIRMED" as const };
  },
};
