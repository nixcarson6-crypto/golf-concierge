/**
 * GolfNow Affiliate API partner. Real client lands here when credentials
 * arrive; today this returns a high-fidelity stub that exercises every code
 * path the executor depends on (hold + confirm, retry-friendly errors).
 *
 * What the real implementation needs to do:
 *   - search(): hit /availability with the course slug + party size + date
 *   - quote(): pick the best tee window matching the requested time
 *   - hold(): /hold with 15-minute TTL, returns hold token
 *   - confirm(): /book with the hold token + payer metadata
 *   - cancel(): /cancel by booking reference
 *   - getStatus(): /booking/:ref for reconciliation
 *
 * Read GOLFNOW_API_KEY + GOLFNOW_PARTNER_ID from env when wiring up.
 */

import { nanoid } from "nanoid";
import type {
  BookingPartner,
  BookingQuote,
  BookingRequest,
  BookingResult,
} from "../types";

const HOLD_MINUTES = 15;

export const golfnowPartner: BookingPartner = {
  provider: "GOLFNOW",
  supports: ["TEE_TIME"],
  isConfigured: () => Boolean(process.env.GOLFNOW_API_KEY),
  supportsHold: true,
  defaultHoldMinutes: HOLD_MINUTES,
  cancellationPolicy:
    "Free cancellation up to 24h before tee time. After that, full charge.",

  async search(req): Promise<BookingQuote[]> {
    // Stub — returns a single quote anchored to the request budget.
    return [
      {
        provider: "GOLFNOW",
        providerReference: `gn_quote_${nanoid(10)}`,
        cost: req.budget ?? 40000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    ];
  },

  async quote(req): Promise<BookingQuote> {
    return (await this.search(req))[0];
  },

  async hold(req, quote): Promise<BookingResult> {
    return {
      provider: "GOLFNOW",
      providerReference: `gn_hold_${nanoid(12)}`,
      confirmationCode: `HOLD-${nanoid(6).toUpperCase()}`,
      cost: quote.cost,
      currency: quote.currency,
      status: "HELD",
      heldUntil: new Date(Date.now() + HOLD_MINUTES * 60 * 1000),
      raw: { quoteRef: quote.providerReference, party: req.party },
    };
  },

  async confirm(providerReference): Promise<BookingResult> {
    return {
      provider: "GOLFNOW",
      providerReference,
      confirmationCode: `GN-${nanoid(8).toUpperCase()}`,
      cost: 0, // real API returns final price including taxes/fees
      currency: "USD",
      status: "CONFIRMED",
    };
  },

  async book(req): Promise<BookingResult> {
    const q = await this.quote(req);
    const held = await this.hold!(req, q);
    return this.confirm!(held.providerReference);
  },

  async cancel() {
    return;
  },

  async getStatus() {
    return { status: "CONFIRMED" as const };
  },
};
