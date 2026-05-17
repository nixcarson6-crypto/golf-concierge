/**
 * Booking provider abstraction.
 *
 * Every category (tee times, lodging, flights, transport, dining) implements
 * this interface. The orchestrator works against the interface; switching
 * partners or adding a new one is a single new file.
 *
 * For MVP we ship stub providers that mark bookings as `HELD` synchronously
 * and produce fake confirmation codes — enough for the end-to-end flow to
 * work in demo. Real partner integrations slot in behind the same surface.
 */

import type { BookingProvider, ItineraryItemType } from "@prisma/client";

export type BookingRequest = {
  tripId: string;
  itineraryItemId: string;
  type: ItineraryItemType;
  title: string;
  startTime?: Date | null;
  endTime?: Date | null;
  party?: number | null;
  budget?: number | null;
  location?: string | null;
  metadata?: Record<string, unknown>;
};

export type BookingQuote = {
  provider: BookingProvider;
  providerReference: string;
  cost: number; // cents
  currency: string;
  expiresAt?: Date;
  raw?: unknown;
};

export type BookingResult = {
  provider: BookingProvider;
  providerReference: string;
  confirmationCode: string;
  cost: number; // cents
  currency: string;
  status: "HELD" | "CONFIRMED";
  heldUntil?: Date;
  raw?: unknown;
};

export type BookingStatusResult = {
  status: "PENDING" | "SEARCHING" | "HELD" | "CONFIRMED" | "FAILED" | "CANCELLED";
  raw?: unknown;
};

export interface BookingPartner {
  readonly provider: BookingProvider;
  readonly supports: ItineraryItemType[];
  /** Whether this provider has the credentials it needs to operate. */
  isConfigured(): boolean;
  search(req: BookingRequest): Promise<BookingQuote[]>;
  quote(req: BookingRequest): Promise<BookingQuote>;
  book(req: BookingRequest): Promise<BookingResult>;
  cancel(providerReference: string): Promise<void>;
  getStatus(providerReference: string): Promise<BookingStatusResult>;
}
