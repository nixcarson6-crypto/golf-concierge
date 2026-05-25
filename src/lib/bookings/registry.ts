import type { BookingProvider, ItineraryItemType } from "@prisma/client";
import { stubPartner } from "./providers/stub";
import { golfnowPartner } from "./providers/golfnow";
import { duffelPartner } from "./providers/duffel";
import { expediaRapidPartner } from "./providers/expedia";
import { opentablePartner } from "./providers/opentable";
import { uberPartner } from "./providers/uber";
import { blacklanePartner } from "./providers/blacklane";
import type { BookingPartner } from "./types";

/**
 * Maps each itinerary-item category to the partner we'll use. Real partner
 * implementations live in providers/. Each is structured to drop in a real
 * client behind the same interface — today they return high-fidelity stubs
 * exercising the full executor code path.
 *
 * If a partner isn't configured (no credentials), the executor falls back
 * to the generic stub so demos still complete end-to-end.
 */
function pick(
  preferred: BookingPartner,
  type: ItineraryItemType,
  fallbackProvider: BookingProvider = "MANUAL",
): BookingPartner {
  if (preferred.isConfigured()) return preferred;
  return stubPartner(fallbackProvider, [type]);
}

const REGISTRY: Record<ItineraryItemType, BookingPartner> = {
  TEE_TIME: pick(golfnowPartner, "TEE_TIME", "GOLFNOW"),
  LODGING: pick(expediaRapidPartner, "LODGING", "EXPEDIA_RAPID"),
  DINING: pick(opentablePartner, "DINING", "OPENTABLE"),
  NIGHTLIFE: stubPartner("MANUAL", ["NIGHTLIFE"]),
  // Blacklane is the on-brand luxury chauffeur (Mercedes S-Class, suited
  // driver) and takes priority when its key is set. Falls through to Uber
  // for Business — and then to the generic stub — when neither has
  // credentials. Both keys configured ⇒ Blacklane wins for the partner
  // routing; per-transfer choice can still be driven by trip preference
  // at the prompt layer.
  TRANSPORT: blacklanePartner.isConfigured()
    ? blacklanePartner
    : pick(uberPartner, "TRANSPORT", "UBER_FOR_BUSINESS"),
  FLIGHT: pick(duffelPartner, "FLIGHT", "DUFFEL"),
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
    case "BLACKLANE":
      return "Blacklane";
    case "INTERNAL":
      return "Concierge";
    case "MANUAL":
      return "Concierge — manual";
  }
}
