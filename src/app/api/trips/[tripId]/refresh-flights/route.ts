/**
 * Re-run the Duffel flight search for an existing trip with a fresh origin
 * airport. Used by the "Set home airport" CTA on the result page when the
 * original build produced no `suggestedFlights` (typically because the quiz
 * didn't capture an origin). The handler resolves the user's typed airport
 * (IATA or city name → IATA via airportForDestination), then mirrors the
 * pre-search logic in build/route.ts so the same `trip.constraints.suggestedFlights`
 * shape is populated and the existing UI picks it up on the next refetch.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { searchFlights } from "@/lib/bookings/providers/duffel-search";
import { airportForDestination } from "@/lib/data/airport-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  origin: z.string().min(2).max(64),
  cabin: z
    .enum(["economy", "premium_economy", "business", "first"])
    .optional()
    .default("business"),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();
  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    include: { legs: { orderBy: { legIndex: "asc" } } },
  });
  if (!trip) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { origin, cabin } = parsed.data;

  // Resolve the typed origin to an IATA. Accept both raw codes ("DFW") and
  // city names ("Dallas") — same lookup as the destination side.
  const cleaned = origin.replace(/\s+/g, "").toUpperCase();
  const originIata = /^[A-Z]{3}$/.test(cleaned)
    ? cleaned
    : ((await airportForDestination(origin)) ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(originIata)) {
    return NextResponse.json(
      {
        error:
          "We couldn't recognise that airport — try a 3-letter code (e.g. DFW, JFK) or a major city name.",
      },
      { status: 400 },
    );
  }

  // Build the same slice set the original build pipeline uses. For single-
  // leg trips: outbound + return. For multi-leg: outbound (home → leg 0)
  // + final return (last leg → home). Inter-leg hops stay as
  // train/drive (the itinerary handles those).
  const legs = trip.legs.length
    ? trip.legs.map((l) => ({
        destination: l.destination,
        startDate: l.startDate?.toISOString().slice(0, 10) ?? null,
        endDate: l.endDate?.toISOString().slice(0, 10) ?? null,
      }))
    : trip.destination
      ? [
          {
            destination: trip.destination,
            startDate: trip.startDate?.toISOString().slice(0, 10) ?? null,
            endDate: trip.endDate?.toISOString().slice(0, 10) ?? null,
          },
        ]
      : [];
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  if (!firstLeg?.startDate || !lastLeg?.endDate) {
    return NextResponse.json(
      { error: "Trip doesn't have full dates set yet." },
      { status: 400 },
    );
  }

  const [firstIata, lastIata] = await Promise.all([
    airportForDestination(firstLeg.destination),
    legs.length > 1 ? airportForDestination(lastLeg.destination) : Promise.resolve(null),
  ]);
  const finalReturnFrom = lastIata ?? firstIata;
  if (!firstIata || !finalReturnFrom) {
    return NextResponse.json(
      { error: "Couldn't determine the destination airports for this trip." },
      { status: 400 },
    );
  }

  const slices = [
    {
      origin: originIata,
      destination: firstIata,
      departureDate: firstLeg.startDate,
    },
    {
      origin: finalReturnFrom,
      destination: originIata,
      departureDate: lastLeg.endDate,
    },
  ];

  const groupSize = trip.groupSize ?? 2;
  const result = await searchFlights({
    slices,
    passengers: groupSize,
    cabin,
    maxOffers: 5,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: `Flight search failed: ${result.error ?? "unknown"}` },
      { status: 502 },
    );
  }

  // Persist into trip.constraints.suggestedFlights — same key the UI reads.
  const existing =
    (trip.constraints as Record<string, unknown> | null) ?? {};
  const suggestedFlights = {
    fetchedAt: new Date().toISOString(),
    origin: originIata,
    destination: firstIata,
    cabin,
    passengers: groupSize,
    offers: result.offers.slice(0, 3),
    legs:
      legs.length > 1
        ? legs.map((l, i) => ({
            index: i,
            destination: l.destination,
            airport: i === 0 ? firstIata : i === legs.length - 1 ? finalReturnFrom : null,
            startDate: l.startDate,
            endDate: l.endDate,
          }))
        : undefined,
  };
  await db.trip.update({
    where: { id: tripId },
    data: {
      constraints: {
        ...existing,
        suggestedFlights,
      } as object,
    },
  });
  // Stick the chosen origin to the user's profile so every future trip
  // build pre-fills with this airport — the customer will not see the
  // "Set your home airport" banner again.
  void db.user
    .update({
      where: { id: user.id },
      data: { defaultOriginAirport: originIata },
    })
    .catch(() => {});
  nudge(tripId);

  return NextResponse.json({
    ok: true,
    origin: originIata,
    offers: result.offers.length,
  });
}
