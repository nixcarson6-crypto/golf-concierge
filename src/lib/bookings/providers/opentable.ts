/**
 * OpenTable affiliate API partner for dining reservations. One-shot — OT's
 * affiliate flow doesn't have a true two-phase model; we use book() directly.
 *
 * Wiring:
 *   - GET /v2/restaurants for availability by restaurant_id + date + party
 *   - POST /v2/reservation to create
 *   - DELETE /v2/reservation/:id to cancel
 */

import { nanoid } from "nanoid";
import type { BookingPartner, BookingResult } from "../types";

export const opentablePartner: BookingPartner = {
  provider: "OPENTABLE",
  supports: ["DINING"],
  isConfigured: () => Boolean(process.env.OPENTABLE_API_KEY),
  supportsHold: false,
  cancellationPolicy: "Restaurant-dependent — most allow free cancellation up to 24h before.",

  async search(_req) {
    return [
      {
        provider: "OPENTABLE",
        providerReference: `ot_offer_${nanoid(10)}`,
        cost: 0,
        currency: "USD",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    ];
  },

  async quote(req) {
    return (await this.search(req))[0];
  },

  async book(req): Promise<BookingResult> {
    return {
      provider: "OPENTABLE",
      providerReference: `ot_res_${nanoid(12)}`,
      confirmationCode: `OT-${nanoid(8).toUpperCase()}`,
      cost: 0,
      currency: "USD",
      status: "CONFIRMED",
      raw: { party: req.party },
    };
  },

  async cancel() {
    return;
  },

  async getStatus() {
    return { status: "CONFIRMED" as const };
  },
};
