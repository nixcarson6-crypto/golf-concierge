import type { ItineraryItem } from "@prisma/client";
import { findDestination } from "@/lib/data/destinations";
import { unsplashUrlFor } from "@/lib/data/imagery";

/**
 * Picks a hero image for the trip summary. Deterministic, fast — no LLM call
 * needed. Strategy: prefer the destination's curated hero query; otherwise
 * derive a search term from the highest-cost tee time or the most distinctive
 * itinerary item. Falls back to a generic luxury golf query.
 */
export async function selectCoverImage(args: {
  destination: string | null;
  itinerary: ItineraryItem[];
}): Promise<string | null> {
  const { destination, itinerary } = args;

  if (destination) {
    const kb = findDestination(destination);
    if (kb) return unsplashUrlFor(kb.heroImageQuery);
  }

  const teeTimes = itinerary
    .filter((i) => i.type === "TEE_TIME")
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  if (teeTimes[0]) {
    return unsplashUrlFor(`${teeTimes[0].title} golf course sunrise`);
  }

  const lodging = itinerary.find((i) => i.type === "LODGING");
  if (lodging) return unsplashUrlFor(`${lodging.title} resort`);

  if (destination) return unsplashUrlFor(`${destination} luxury golf resort`);
  return unsplashUrlFor("luxury golf resort sunrise");
}
