/**
 * Per-card refinement for the "Pick your flight" section. Lets the user
 * tweak the search ("Cheaper", "Nonstop only", "Earlier", "Later",
 * "Different airline") without any AI call — just re-runs Duffel with
 * adjusted params + client-side filters.
 *
 * Cost: zero AI tokens. This is the primary lever for keeping per-trip
 * spend bounded — most user "opinions" on a generated plan are
 * mechanical refinements, not creative substitutions, and those don't
 * need a model.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import {
  searchFlights,
  type FlightOfferSummary,
} from "@/lib/bookings/providers/duffel-search";

const bodySchema = z.object({
  modifier: z.enum([
    "cheaper",
    "nonstop",
    "earlier",
    "later",
    "different_airline",
  ]),
});

type SuggestedFlightsBlock = {
  fetchedAt: string;
  origin: string;
  destination: string;
  cabin: "first" | "business" | "premium_economy" | "economy";
  passengers: number;
  offers: FlightOfferSummary[];
};

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    select: { constraints: true, startDate: true, endDate: true },
  });
  if (!trip) return new Response("not found", { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("invalid body", { status: 400 });
  const modifier = parsed.data.modifier;

  const constraints = (trip.constraints ?? {}) as Record<string, unknown>;
  const prior = constraints.suggestedFlights as SuggestedFlightsBlock | undefined;
  if (!prior) {
    return new Response(
      JSON.stringify({ error: "No flight search exists for this trip yet." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Decide what to ask Duffel for vs filter client-side. "cheaper" is
  // the only modifier that genuinely needs a fresh search (we drop the
  // cabin one notch). The other modifiers re-search at the SAME params
  // so we get a fresh batch of expiring offers, then filter the result.
  const startDate = trip.startDate?.toISOString().slice(0, 10) ?? null;
  const endDate = trip.endDate?.toISOString().slice(0, 10) ?? null;
  if (!startDate || !endDate) {
    return new Response(
      JSON.stringify({ error: "Trip dates missing — can't re-search." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const cabinForSearch: SuggestedFlightsBlock["cabin"] =
    modifier === "cheaper"
      ? downgradeCabin(prior.cabin)
      : prior.cabin;

  const result = await searchFlights({
    slices: [
      {
        origin: prior.origin,
        destination: prior.destination,
        departureDate: startDate,
      },
      {
        origin: prior.destination,
        destination: prior.origin,
        departureDate: endDate,
      },
    ],
    passengers: prior.passengers,
    cabin: cabinForSearch,
    maxOffers: 12, // wider net so post-filter we still have 3 to show
  });
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: result.error }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let filtered = result.offers;
  if (modifier === "nonstop") {
    filtered = filtered.filter((o) =>
      o.slices.every((s) => s.stops === 0),
    );
  } else if (modifier === "earlier") {
    // Outbound depart hour ≤ 11am.
    filtered = filtered.filter((o) => {
      const out = o.slices[0];
      if (!out) return false;
      const hr = new Date(out.departing).getHours();
      return hr < 12;
    });
  } else if (modifier === "later") {
    // Outbound depart hour ≥ noon.
    filtered = filtered.filter((o) => {
      const out = o.slices[0];
      if (!out) return false;
      const hr = new Date(out.departing).getHours();
      return hr >= 12;
    });
  } else if (modifier === "different_airline") {
    // Exclude every airline that was in the prior result set so we
    // surface alternatives the user hasn't seen yet.
    const seen = new Set(prior.offers.map((o) => o.airlineIataCode.toUpperCase()));
    filtered = filtered.filter(
      (o) => !seen.has(o.airlineIataCode.toUpperCase()),
    );
  }

  if (filtered.length === 0) {
    return new Response(
      JSON.stringify({
        error: `No flights match "${modifier.replace("_", " ")}" — try a different filter.`,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Re-sort by price (cheapest first) and keep top 3.
  filtered.sort((a, b) => a.totalAmount - b.totalAmount);
  const updatedBlock: SuggestedFlightsBlock = {
    fetchedAt: new Date().toISOString(),
    origin: prior.origin,
    destination: prior.destination,
    cabin: cabinForSearch,
    passengers: prior.passengers,
    offers: filtered.slice(0, 3),
  };

  await db.trip.update({
    where: { id: tripId },
    data: {
      constraints: {
        ...constraints,
        suggestedFlights: updatedBlock,
      } as object,
    },
  });
  nudge(tripId);

  return new Response(
    JSON.stringify({ ok: true, count: updatedBlock.offers.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function downgradeCabin(
  cabin: SuggestedFlightsBlock["cabin"],
): SuggestedFlightsBlock["cabin"] {
  if (cabin === "first") return "business";
  if (cabin === "business") return "premium_economy";
  if (cabin === "premium_economy") return "economy";
  return "economy"; // already at the bottom
}
