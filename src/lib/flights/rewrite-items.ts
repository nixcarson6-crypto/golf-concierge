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

  const slices = offer.slices;

  // Dedupe: the AI sometimes emits more FLIGHT items than the offer has
  // slices (we've seen 4 items for a round-trip — 1 outbound + 3 identical
  // returns, multiplying the flight total by 2). The offer's slice count
  // is ground truth: keep exactly that many items (in order), delete any
  // extras. Without this guard the old code mapped every extra item to
  // `slices[last]`, producing visible duplicate cards on the result page.
  const keep = flightItems.slice(0, slices.length);
  const drop = flightItems.slice(slices.length);
  if (drop.length > 0) {
    console.warn(
      `[rewrite-flights] AI emitted ${flightItems.length} FLIGHT items but offer has ${slices.length} slices — deleting ${drop.length} extra(s) to avoid duplicate cards.`,
    );
    await db.itineraryItem.deleteMany({
      where: { id: { in: drop.map((d) => d.id) } },
    });
  }

  for (let i = 0; i < keep.length; i++) {
    const item = keep[i];
    const meta = (item.metadata as Record<string, unknown> | null) ?? {};
    // Map item → slice by index. The AI emits items in flight order
    // (outbound, [inter-leg hops…], return), and Duffel returns slices
    // in the same order we asked for them — so item[i] ↔ slice[i] is
    // correct for round-trips AND multi-leg trips. Honour an explicit
    // metadata.segment hint when present, falling back to "outbound"
    // for the first, "return" for the last, "inter" otherwise.
    const slice = slices[i];
    const segment: "outbound" | "return" | "inter" =
      meta.segment === "outbound" || meta.segment === "return"
        ? meta.segment
        : i === 0
          ? "outbound"
          : i === keep.length - 1
            ? "return"
            : "inter";

    const title = `${offer.airlineName} · ${slice.origin} → ${slice.destination}`;
    const stopsLabel = slice.stops === 0 ? "nonstop" : `${slice.stops} stop`;
    const description = `${slice.origin} ${formatTime(slice.departing)} → ${slice.destination} ${formatTime(slice.arriving)} · ${formatDuration(slice.durationMinutes)} · ${stopsLabel} · ${formatCabin(slice.cabin)}`;
    const startTime = parseIsoDate(slice.departing);
    const endTime = parseIsoDate(slice.arriving);
    // Per-slice cost = (offer total / slice count) × passengers / passengers
    // i.e. the offer's per-pax amount divided across slices × passengers.
    // Apportioning across slices avoids the "one outbound at full fare +
    // returns at full fare" sum > offer total bug.
    const costCents = Math.round(
      (offer.perPassengerAmount * args.passengers) / slices.length,
    );

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
          segment,
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
