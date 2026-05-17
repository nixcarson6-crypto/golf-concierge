import type { BookingProvider, ItineraryItemType } from "@prisma/client";
import { stubPartner } from "./providers/stub";
import type { BookingPartner } from "./types";

/**
 * Maps each itinerary-item category to the partner we'll use. Today every
 * category points at the stub partner; real implementations land here as
 * GolfNow, Expedia Rapid, Duffel, OpenTable, Uber for Business respectively
 * — each as a single file in providers/ implementing BookingPartner.
 */
const REGISTRY: Record<ItineraryItemType, BookingPartner> = {
  TEE_TIME: stubPartner("GOLFNOW", ["TEE_TIME"]),
  LODGING: stubPartner("EXPEDIA_RAPID", ["LODGING"]),
  DINING: stubPartner("OPENTABLE", ["DINING"]),
  NIGHTLIFE: stubPartner("MANUAL", ["NIGHTLIFE"]),
  TRANSPORT: stubPartner("UBER_FOR_BUSINESS", ["TRANSPORT"]),
  FLIGHT: stubPartner("DUFFEL", ["FLIGHT"]),
  FREE_TIME: stubPartner("INTERNAL", ["FREE_TIME"]),
  SPA: stubPartner("MANUAL", ["SPA"]),
  ACTIVITY: stubPartner("MANUAL", ["ACTIVITY"]),
};

export function partnerFor(type: ItineraryItemType): BookingPartner {
  return REGISTRY[type];
}

export function providerLabel(provider: BookingProvider): string {
  switch (provider) {
    case "GOLFNOW":
      return "GolfNow";
    case "SUPREME_GOLF":
      return "Supreme Golf";
    case "EXPEDIA_RAPID":
      return "Expedia Rapid";
    case "BOOKING_DOT_COM":
      return "Booking.com";
    case "AMADEUS":
      return "Amadeus";
    case "DUFFEL":
      return "Duffel";
    case "OPENTABLE":
      return "OpenTable";
    case "RESY":
      return "Resy";
    case "UBER_FOR_BUSINESS":
      return "Uber for Business";
    case "INTERNAL":
      return "Concierge";
    case "MANUAL":
      return "Concierge — manual";
  }
}
