import { nanoid } from "nanoid";
import type {
  BookingPartner,
  BookingQuote,
  BookingRequest,
  BookingResult,
  BookingStatusResult,
} from "../types";
import type { BookingProvider, ItineraryItemType } from "@prisma/client";

/**
 * Stub partner used until real provider credentials are wired up. It pretends
 * to hold the booking, returns a fake confirmation code, and reports
 * confirmed status. Lets the entire end-to-end flow (approve → book → pay →
 * summary) be demoable before real partner integrations land.
 *
 * Real providers (GolfNow, Expedia Rapid, Duffel, OpenTable, Uber for Business)
 * implement the same `BookingPartner` interface — see `lib/bookings/types.ts`.
 */
export function stubPartner(
  provider: BookingProvider,
  supports: ItineraryItemType[],
): BookingPartner {
  return {
    provider,
    supports,
    isConfigured: () => true,
    async search(req): Promise<BookingQuote[]> {
      const base = req.budget ?? 50000;
      return [
        {
          provider,
          providerReference: `quote_${nanoid(10)}`,
          cost: base,
          currency: "USD",
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      ];
    },
    async quote(req): Promise<BookingQuote> {
      return {
        provider,
        providerReference: `quote_${nanoid(10)}`,
        cost: req.budget ?? 50000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      };
    },
    async book(req): Promise<BookingResult> {
      return {
        provider,
        providerReference: `book_${nanoid(12)}`,
        confirmationCode: `GC-${nanoid(8).toUpperCase()}`,
        cost: req.budget ?? 50000,
        currency: "USD",
        status: "CONFIRMED",
        heldUntil: new Date(Date.now() + 60 * 60 * 1000),
      };
    },
    async cancel() {
      return;
    },
    async getStatus(): Promise<BookingStatusResult> {
      return { status: "CONFIRMED" };
    },
  };
}
