/**
 * Expedia Rapid API partner for hotels. Two-phase: pre-book → book.
 *
 * Real wiring:
 *   - GET /lodging/availability with hotel_id + checkin/checkout + occupancy
 *   - POST /itinerary with payment session → returns itinerary_id (HOLD)
 *   - PUT /itinerary/:id/payment to commit → CONFIRMED
 *   - DELETE /itinerary/:id to cancel
 *
 * EXPEDIA_RAPID_API_KEY + EXPEDIA_RAPID_SECRET in env.
 */

import { nanoid } from "nanoid";
import type {
  BookingPartner,
  BookingQuote,
  BookingResult,
} from "../types";

export const expediaRapidPartner: BookingPartner = {
  provider: "EXPEDIA_RAPID",
  supports: ["LODGING"],
  isConfigured: () => Boolean(process.env.EXPEDIA_RAPID_API_KEY),
  supportsHold: true,
  defaultHoldMinutes: 30,
  cancellationPolicy:
    "Per property. We surface the rate plan's cancellation window at quote time.",

  async search(req) {
    return [
      {
        provider: "EXPEDIA_RAPID",
        providerReference: `ex_offer_${nanoid(10)}`,
        cost: req.budget ?? 250000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    ] satisfies BookingQuote[];
  },

  async quote(req) {
    return (await this.search(req))[0];
  },

  async hold(_req, quote): Promise<BookingResult> {
    return {
      provider: "EXPEDIA_RAPID",
      providerReference: `ex_hold_${nanoid(12)}`,
      confirmationCode: `EX-HOLD-${nanoid(5).toUpperCase()}`,
      cost: quote.cost,
      currency: quote.currency,
      status: "HELD",
      heldUntil: new Date(Date.now() + 30 * 60 * 1000),
    };
  },

  async confirm(providerReference): Promise<BookingResult> {
    return {
      provider: "EXPEDIA_RAPID",
      providerReference,
      confirmationCode: `EX-${nanoid(8).toUpperCase()}`,
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
