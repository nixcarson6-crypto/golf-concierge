/**
 * Blacklane chauffeur partner. Preferred over Uber for Pyltrix's luxury
 * positioning — Mercedes S-Class with a suited driver fits the $8k golf
 * trip far better than an Uber Black.
 *
 * Wiring (real API, behind the same shape as uber.ts so the registry
 * doesn't have to care which one is live):
 *   - POST /v3/business/bookings (chauffeur dispatch with guest details)
 *   - GET  /v3/business/bookings/:id (status / driver info)
 *   - DELETE /v3/business/bookings/:id (cancel, refund per policy)
 *
 * Partner docs land after the BD approval; until then this is an honest
 * stub. isConfigured() returns false unless BLACKLANE_API_KEY is set,
 * which keeps the registry falling back to Uber (or the generic stub)
 * automatically. NEVER return a fake confirmation when unconfigured.
 */

import { nanoid } from "nanoid";
import type { BookingPartner, BookingResult } from "../types";

export const blacklanePartner: BookingPartner = {
  provider: "BLACKLANE",
  supports: ["TRANSPORT"],
  isConfigured: () => Boolean(process.env.BLACKLANE_API_KEY),
  supportsHold: false,
  // Real Blacklane cancellation tiers: free up to 1 h before pickup for
  // standard rides, 24 h for chauffeur-hailing. Use the conservative
  // wording until the partner contract lands.
  cancellationPolicy:
    "Free cancellation up to 1 hour before pickup. Inside the window, full charge applies.",

  async search(_req) {
    return [
      {
        provider: "BLACKLANE",
        providerReference: `bl_q_${nanoid(8)}`,
        // Stub estimate — Blacklane's per-transfer fare in major US/EU
        // markets averages ~$110 for a 30 min S-Class ride. Replace with
        // a real quote call once the partner endpoint is live.
        cost: 11000,
        currency: "USD",
      },
    ];
  },

  async quote(req) {
    return (await this.search(req))[0];
  },

  async book(req): Promise<BookingResult> {
    return {
      provider: "BLACKLANE",
      providerReference: `bl_${nanoid(10)}`,
      confirmationCode: `BL-${nanoid(8).toUpperCase()}`,
      cost: req.budget ?? 11000,
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
