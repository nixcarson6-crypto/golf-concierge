/**
 * Shared helper: rewrite the persisted FLIGHT itinerary items so they
 * reflect a concrete Duffel offer (real airline, airports, times, cost)
 * instead of the synthesized placeholders the AI emits during build.
 *
 * Called from both the initial build pipeline AND the per-card refinement
 * endpoint, so the "Cheaper / Nonstop / Earlier / Later / Different
 * airline" chips actually change what the customer sees on the flight
 * cards (not just an invisible suggestedFlights blob).
 */

import { db } from "@/lib/db";
import type { FlightOfferSummary } from "@/lib/bookings/providers/duffel-search";

export async function rewriteFlightItemsFromOffer(args: {
  tripId: string;
  offer: FlightOfferSummary;
  passengers: number;
}): Promise<void> {
  const { offer } = args;
  if (!offer || !Array.isArray(offer.slices) || offer.slices.length === 0) return;

  const currentItinerary = await db.itinerary.findFirst({
    where: { tripId: args.tripId, status: "CURRENT" },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (!currentItinerary) return;

  const flightItems = await db.itineraryItem.findMany({
    where: { itineraryId: currentItinerary.id, type: "FLIGHT" },
    orderBy: { orderIndex: "asc" },
  });
  if (flightItems.length === 0) return;

  const outbound = offer.slices[0];
  const returnSlice = offer.slices[offer.slices.length - 1];

  for (const item of flightItems) {
    const meta = (item.metadata as Record<string, unknown> | null) ?? {};
    const segment =
      meta.segment === "return"
        ? "return"
        : meta.segment === "outbound"
          ? "outbound"
          : null;
    let slice: typeof outbound | null = null;
    if (segment === "return") slice = returnSlice;
    else if (segment === "outbound") slice = outbound;
    else {
      const idx = flightItems.indexOf(item);
      slice = idx === 0 ? outbound : returnSlice;
    }
    if (!slice) continue;

    const title = `${offer.airlineName} · ${slice.origin} → ${slice.destination}`;
    const stopsLabel = slice.stops === 0 ? "nonstop" : `${slice.stops} stop`;
    const description = `${slice.origin} ${formatTime(slice.departing)} → ${slice.destination} ${formatTime(slice.arriving)} · ${formatDuration(slice.durationMinutes)} · ${stopsLabel} · ${formatCabin(slice.cabin)}`;
    const startTime = parseIsoDate(slice.departing);
    const endTime = parseIsoDate(slice.arriving);
    const costCents = Math.round(offer.perPassengerAmount * args.passengers);

    await db.itineraryItem.update({
      where: { id: item.id },
      data: {
        title,
        description,
        startTime,
        endTime,
        cost: costCents,
        location: `${slice.origin} → ${slice.destination}`,
        metadata: {
          ...meta,
          from: slice.origin,
          to: slice.destination,
          airline: offer.airlineName,
          airlineCode: offer.airlineIataCode,
          offerId: offer.id,
          segment: segment ?? (item === flightItems[0] ? "outbound" : "return"),
        } as object,
      },
    });
  }
}

function parseIsoDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTime(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function formatCabin(cabin: string): string {
  const c = (cabin ?? "").toLowerCase();
  if (c === "business") return "business class";
  if (c === "first") return "first class";
  if (c === "premium_economy") return "premium economy";
  return "economy";
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
