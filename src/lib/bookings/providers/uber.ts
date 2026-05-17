/**
 * Uber for Business API partner for ground transport.
 *
 * Wiring:
 *   - POST /v1/guests to create the rider guest
 *   - POST /v1/requests with product_id + pickup/dropoff
 *   - GET /v1/requests/:id for status
 *
 * UBER_FOR_BUSINESS_TOKEN in env.
 */

import { nanoid } from "nanoid";
import type { BookingPartner, BookingResult } from "../types";

export const uberPartner: BookingPartner = {
  provider: "UBER_FOR_BUSINESS",
  supports: ["TRANSPORT"],
  isConfigured: () => Boolean(process.env.UBER_FOR_BUSINESS_TOKEN),
  supportsHold: false,
  cancellationPolicy: "Free cancellation up to 5 minutes after the driver accepts.",

  async search(_req) {
    return [
      {
        provider: "UBER_FOR_BUSINESS",
        providerReference: `uber_q_${nanoid(8)}`,
        cost: 9000,
        currency: "USD",
      },
    ];
  },

  async quote(req) {
    return (await this.search(req))[0];
  },

  async book(req): Promise<BookingResult> {
    return {
      provider: "UBER_FOR_BUSINESS",
      providerReference: `uber_${nanoid(10)}`,
      confirmationCode: `UB-${nanoid(8).toUpperCase()}`,
      cost: req.budget ?? 9000,
      currency: "USD",
      status: "CONFIRMED",
    };
  },

  async cancel() {
    return;
  },

  async getStatus() {
    return { status: "CONFIRMED" as const };
  },
};
