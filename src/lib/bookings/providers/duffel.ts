/**
 * Duffel API partner for flights. High-fidelity stub with hold + confirm
 * matching Duffel's "offer → order" two-phase model.
 *
 * When wiring up the real client:
 *   - POST /air/offer_requests with origin/destination/date/cabin/passengers
 *   - GET /air/offers/:id for the chosen offer
 *   - POST /air/orders (with type="hold_order" or "instant_order") for hold
 *   - PUT /air/orders/:id/payment for confirmation
 *   - DELETE /air/orders/:id to cancel
 *
 * Read DUFFEL_API_KEY from env. Use the official @duffel/api package.
 */

import { nanoid } from "nanoid";
import type {
  BookingPartner,
  BookingQuote,
  BookingResult,
} from "../types";

export const duffelPartner: BookingPartner = {
  provider: "DUFFEL",
  supports: ["FLIGHT"],
  isConfigured: () => Boolean(process.env.DUFFEL_API_KEY),
  supportsHold: true,
  defaultHoldMinutes: 30,
  cancellationPolicy:
    "Per airline. We surface the offer's fare conditions before charging.",

  async search(req) {
    const base = req.budget ?? 60000;
    return [
      {
        provider: "DUFFEL",
        providerReference: `df_offer_${nanoid(10)}`,
        cost: base,
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
