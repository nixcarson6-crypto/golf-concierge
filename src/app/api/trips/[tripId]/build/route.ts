/**
 * Quiz → trip build pipeline. Takes the answers from the Hungry Root-
 * style intake, maps them to TripConstraints, and runs the destination
 * + itinerary agents ONCE to produce a complete plan. No streaming, no
 * agentic loops — the per-trip API cost is bounded to two model calls.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db, withDbRetry } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { quizAnswersToConstraints } from "@/lib/quiz/golf-questions";
import { runDestinationAgent } from "@/lib/ai/agents/destination";
import { runItineraryAgent } from "@/lib/ai/agents/itinerary";
import { buildMultiLegItinerary } from "@/lib/ai/agents/itinerary-multi-leg";
import {
  persistItinerary,
  autoTitle,
  cleanDestination,
} from "@/lib/ai/conversation";
import { nudge } from "@/lib/events";
import { searchFlights } from "@/lib/bookings/providers/duffel-search";
import {
  parseLegs,
  assignDatesToLegs,
  type LegWithDates,
} from "@/lib/quiz/parse-legs";
import { airportForDestination } from "@/lib/data/airport-lookup";

const bodySchema = z.object({
  answers: z.record(z.unknown()),
});

// Build can legitimately take 1-3 minutes on a complex multi-leg trip
// (Opus call + Duffel multi-slice search + DB writes). Default Vercel
// serverless timeout is 60s which silently kills long builds and the
// client sees an empty hang. 300s = max for Vercel Pro / matches the
// new 24k-token retry path budget.
export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
  });
  if (!trip) return new Response("not found", { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("invalid body", { status: 400 });

  const rawConstraints = quizAnswersToConstraints(parsed.data.answers);
  // Clean up freeform destination text ("Let's go to Pinehurst..." → "Pinehurst")
  // so the trip title and downstream agents work with the place name only.
  const cleanedPrimary = cleanDestination(rawConstraints.destination);
  // Detect multi-destination intent ("Pinehurst for 5 days then Broadmoor
  // for 4") and preserve the full original phrasing in notes so the AI
  // itinerary agent knows to plan a multi-leg trip even though we only
  // pass it a single primary destination today. Full multi-leg trip
  // support (multiple destinations as separate entities) is roadmap.
  const rawDest = (rawConstraints.destination ?? "").trim();
  const looksMultiDest =
    /\s+(?:then|and\s+then|plus|after\s+that|followed\s+by)\s+/i.test(rawDest) ||
    /(?:for\s+\d+\s+(?:day|night)s?.+(?:for\s+\d+\s+(?:day|night)s?))/i.test(rawDest);
  const constraints = {
    ...rawConstraints,
    destination: cleanedPrimary,
    notes: looksMultiDest
      ? `Multi-destination request — user originally wrote: "${rawDest}". Plan a multi-leg trip respecting the split they described. Primary destination for downstream APIs is "${cleanedPrimary ?? rawDest}". ${rawConstraints.notes ?? ""}`.trim()
      : rawConstraints.notes,
  };
  const newTitle = autoTitle({ currentTitle: trip.title, constraints });

  // Persist the constraints + new title so the trip header reflects the
  // quiz immediately, even before generation completes.
  await db.trip.update({
    where: { id: tripId },
    data: {
      destination: constraints.destination ?? trip.destination,
      startDate: constraints.startDate
        ? new Date(constraints.startDate)
        : trip.startDate,
      endDate: constraints.endDate ? new Date(constraints.endDate) : trip.endDate,
      groupSize: constraints.groupSize ?? trip.groupSize,
      budgetTotal:
        constraints.budgetTotal != null
          ? constraints.budgetTotal * 100
          : trip.budgetTotal,
      budgetPerPerson:
        constraints.budgetPerPerson != null
          ? constraints.budgetPerPerson * 100
          : trip.budgetPerPerson,
      luxuryLevel: constraints.luxuryLevel ?? trip.luxuryLevel,
      constraints: constraints as object,
      status: "PLANNING",
      ...(newTitle && newTitle !== trip.title ? { title: newTitle } : {}),
    },
  });
  nudge(tripId);

  // Detect multi-leg from the ORIGINAL user input (rawDest) since the
  // single-destination cleaning only kept the first leg's name. If we
  // parse 2+ legs we route through the multi-leg flow that creates
  // TripLeg rows and structures the itinerary + flight search per leg.
  const parsedLegs = rawDest ? parseLegs(rawDest) : null;
  const isMultiLeg = parsedLegs != null && parsedLegs.length >= 2;

  // Step 1: resolve legs. Single-leg trips become a TripLeg with
  // legIndex=0 for schema uniformity; multi-leg trips become N legs
  // with explicit date ranges. The itinerary agent gets the full leg
  // structure in `notes` so it can emit items tagged by legIndex.
  let chosenDestination: string;
  let legs: LegWithDates[];
  let multiLegContextNote = "";

  try {
    if (isMultiLeg) {
      const withDates = assignDatesToLegs(
        parsedLegs!,
        constraints.startDate ?? null,
        constraints.endDate ?? null,
      );
      if (!withDates) {
        return new Response(
          JSON.stringify({
            error:
              "Multi-leg trips need specific depart + return dates. Go back and set both, then try again.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      legs = withDates;
      chosenDestination = legs[0].destination;
      // Update the primary trip destination to leg 0 for the header.
      await db.trip.update({
        where: { id: tripId },
        data: { destination: chosenDestination },
      });
      multiLegContextNote =
        `MULTI-LEG TRIP — ${legs.length} legs. Plan an itinerary that ` +
        `covers ALL legs, with each itinerary item tagged via ` +
        `metadata.legIndex (0-based). Emit a FLIGHT item for the home ` +
        `→ leg 0 hop AND for every inter-leg hop AND for the final ` +
        `leg → home hop, each with metadata.from/metadata.to set to ` +
        `the airport IATA codes for that segment.\n` +
        legs
          .map(
            (l, i) =>
              `  Leg ${i}: ${l.destination} (${l.startDate} → ${l.endDate})`,
          )
          .join("\n");
    } else {
      // Single-leg destination resolution: specific known place vs hint
      // routing (existing logic).
      const userTyped = constraints.destination?.trim() ?? "";
      const useDirectly =
        userTyped.length > 0 && !looksLikeHintNotPlace(userTyped);

      if (useDirectly) {
        chosenDestination = userTyped;
      } else {
        const constraintsForAgent = userTyped
          ? {
              ...constraints,
              destination: null,
              notes: `User's destination hint: "${userTyped}". Pick a real bookable golf destination that matches this hint. ${constraints.notes ?? ""}`.trim(),
            }
          : { ...constraints, destination: null };
        const destRun = await runDestinationAgent({
          tripId,
          constraints: constraintsForAgent,
        });
        const top = destRun.output.options[0];
        if (!top) {
          return new Response(
            JSON.stringify({
              error:
                "Couldn't generate destination options. Try giving us a more specific hint (e.g. 'mountain golf', 'East Coast in July') or pick a destination directly.",
            }),
            { status: 502, headers: { "Content-Type": "application/json" } },
          );
        }
        chosenDestination = top.name;
        await db.trip.update({
          where: { id: tripId },
          data: { destination: chosenDestination },
        });
        nudge(tripId);
      }
      legs = [
        {
          destination: chosenDestination,
          startDate: constraints.startDate ?? "",
          endDate: constraints.endDate ?? "",
        },
      ];
    }
  } catch (err) {
    console.error("[build] destination/leg resolution failed:", err);
    return new Response(
      JSON.stringify({
        error: `Destination step failed: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Persist TripLeg rows. Wipe any old legs first so the trip's leg
  // list is always authoritative for the latest build. Single-leg
  // trips end up with exactly one TripLeg row (legIndex=0).
  try {
    await withDbRetry(
      () => db.tripLeg.deleteMany({ where: { tripId } }),
      "tripLeg.deleteMany",
    );
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      await withDbRetry(
        () =>
          db.tripLeg.create({
            data: {
              tripId,
              legIndex: i,
              destination: leg.destination,
              startDate: leg.startDate ? new Date(leg.startDate) : null,
              endDate: leg.endDate ? new Date(leg.endDate) : null,
            },
          }),
        `tripLeg.create[${i}]`,
      );
    }
  } catch (err) {
    console.warn("[build] TripLeg persistence failed:", err);
    // Non-fatal — the trip can still build with legs only in memory.
  }

  // For multi-leg, fold the leg structure into the constraints note so
  // the itinerary agent sees explicit per-leg expectations.
  const itineraryConstraints = isMultiLeg
    ? {
        ...constraints,
        notes: `${multiLegContextNote}\n\n${constraints.notes ?? ""}`.trim(),
      }
    : constraints;

  // Parse origin + cabin BEFORE firing the itinerary so we can run a
  // flight search in parallel. The home→firstLeg outbound is always a
  // flight (international + first hop), so we can predict its
  // endpoints without waiting for the itinerary to emit FLIGHT items.
  // Multi-leg inter-hops might be train/drive — those still get
  // searched (or skipped) after the itinerary lands.
  const answers = parsed.data.answers;
  const rawOrigin =
    (answers.originAirport as string | undefined) === "custom"
      ? ((answers.originAirportCustom as string | undefined) ?? "")
      : ((answers.originAirport as string | undefined) ?? "");
  const cleanedOrigin = rawOrigin.replace(/\s+/g, "").toUpperCase();
  // Resolve the origin to an IATA code ONCE, here, so every downstream
  // flight path (pre-search, post-itinerary search, display) uses it.
  // Fast path: the quiz already gave a clean 3-letter code. Otherwise
  // resolve a typed city/airport NAME ("Tampa", "Dallas") via the same
  // lookup we use for destinations — the old behaviour required a clean
  // IATA and silently skipped the flight search otherwise, leaving
  // placeholder flights with no fares (the bug Carson hit).
  const originFromQuiz = /^[A-Z]{3}$/.test(cleanedOrigin)
    ? cleanedOrigin
    : rawOrigin
      ? (await airportForDestination(rawOrigin)) ?? ""
      : "";
  const airlinePref = answers.airlinePreference as string | undefined;
  const cabinAnswer =
    airlinePref === "best_rate"
      ? "economy"
      : ((answers.cabinClass as string | undefined) ?? "business");
  const cabin: "first" | "business" | "premium_economy" | "economy" =
    cabinAnswer === "first"
      ? "first"
      : cabinAnswer === "premium_economy"
        ? "premium_economy"
        : cabinAnswer === "economy" || cabinAnswer === "best_deal"
          ? "economy"
          : "business";

  // Pre-fired flight search — runs IN PARALLEL with the itinerary
  // agent. We predict the leg airports from the curated KB / fallback
  // table / Haiku lookup so we don't have to wait for the itinerary
  // to emit FLIGHT items. Saves ~5-10s on the perceived build time
  // because Opus and Duffel run concurrently instead of serially.
  //
  // For single-leg: outbound (home→leg0 on startDate) + return
  // (leg0→home on endDate). For multi-leg: outbound (home→leg0) +
  // final return (lastLeg→home). Inter-leg hops are searched after
  // the itinerary lands since they may turn out to be train/drive.
  const preSearchPromise = (async () => {
    if (!originFromQuiz || legs.length === 0) return null;
    const groupSize = constraints.groupSize ?? 1;
    const firstLeg = legs[0];
    const lastLeg = legs[legs.length - 1];
    if (!firstLeg.startDate || !lastLeg.endDate) return null;
    const [firstIata, lastIata] = await Promise.all([
      airportForDestination(firstLeg.destination),
      legs.length > 1
        ? airportForDestination(lastLeg.destination)
        : Promise.resolve(null), // single-leg → return = outbound airport
    ]);
    const finalReturnFrom = lastIata ?? firstIata;
    if (!firstIata || !finalReturnFrom) return null;
    const slices = [
      {
        origin: originFromQuiz,
        destination: firstIata,
        departureDate: firstLeg.startDate,
      },
      {
        origin: finalReturnFrom,
        destination: originFromQuiz,
        departureDate: lastLeg.endDate,
      },
    ];
    try {
      const result = await searchFlights({
        slices,
        passengers: groupSize,
        cabin,
        maxOffers: 5,
      });
      if (!result.ok) {
        console.warn(
          "[build] pre-search returned error — will fall back to post-itinerary search:",
          result.error,
        );
        return null;
      }
      return {
        offers: result.offers,
        airports: { first: firstIata, return: finalReturnFrom },
      };
    } catch (err) {
      console.warn("[build] pre-search threw — falling back:", err);
      return null;
    }
  })();

  // Step 2: itinerary. Runs in parallel with the pre-search above.
  //
  // Branch on leg count. Single-leg trips run the original one-shot Opus
  // call. Multi-leg trips fan out — ONE itinerary-agent call per leg, all
  // in parallel — and merge. This keeps each call small + fast and prevents
  // the 8-minute client timeout we used to hit on 3+ destinations (where
  // one giant tool-use payload would either truncate at max_tokens or just
  // take longer than the wall clock allowed).
  let itineraryOutput;
  let preSearch: Awaited<typeof preSearchPromise> = null;
  let partialLegFailures: string[] = [];
  try {
    if (isMultiLeg && legs.length >= 2) {
      const [multi, ps] = await Promise.all([
        buildMultiLegItinerary({
          tripId,
          constraints: itineraryConstraints,
          legs,
        }),
        preSearchPromise,
      ]);
      itineraryOutput = multi.itinerary;
      preSearch = ps;
      partialLegFailures = multi.legs
        .filter((l) => l.status === "failed")
        .map((l) => l.destination);
      if (partialLegFailures.length > 0) {
        console.warn(
          `[build] multi-leg partial: failed legs = ${partialLegFailures.join(", ")}`,
        );
      }
      await persistItinerary(tripId, itineraryOutput);
      nudge(tripId);
    } else {
      const [run, ps] = await Promise.all([
        runItineraryAgent({
          tripId,
          destination: chosenDestination,
          constraints: itineraryConstraints,
          priorItinerary: null,
        }),
        preSearchPromise,
      ]);
      itineraryOutput = run.output;
      preSearch = ps;
      await persistItinerary(tripId, itineraryOutput);
      nudge(tripId);
    }
  } catch (err) {
    // Full stack to the terminal for diagnostics; humane, JSON-free copy to
    // the customer. A Zod dump in the UI is unacceptable.
    console.error("[build] itinerary step failed:", err);
    const rawMsg = err instanceof Error ? err.message : String(err);
    const userMsg = friendlyBuildError(rawMsg);
    return new Response(
      JSON.stringify({ error: userMsg }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build flight search slices directly from the itinerary's FLIGHT
  // items. The AI is now instructed to use train/drive for short hops
  // (Rome → Lake Como is a 3 h Frecciarossa, not a 1 h flight + 4 h
  // of airport time), so a multi-leg trip won't always have N+1
  // flights. We slice on whatever FLIGHT items it DID emit. Each one
  // already carries metadata.from/to/date, so this just maps them
  // 1:1 to Duffel slices.
  const flightItems = itineraryOutput.items
    .filter((it) => it.type === "FLIGHT")
    .map((it) => {
      const meta = (it.metadata ?? {}) as {
        from?: string;
        to?: string;
        legIndex?: number;
      };
      return {
        from: (meta.from ?? "").toUpperCase(),
        to: (meta.to ?? "").toUpperCase(),
        legIndex: meta.legIndex,
        date: it.startTime ? new Date(it.startTime).toISOString().slice(0, 10) : null,
      };
    })
    .filter(
      (f): f is { from: string; to: string; legIndex: number | undefined; date: string } =>
        /^[A-Z]{3}$/.test(f.from) && /^[A-Z]{3}$/.test(f.to) && Boolean(f.date),
    )
    // Order by legIndex when present, then by date — keeps the multi-
    // slice search in chronological order even if the AI emitted
    // FLIGHT items out of order.
    .sort((a, b) => {
      const ai = a.legIndex ?? 999;
      const bi = b.legIndex ?? 999;
      if (ai !== bi) return ai - bi;
      return a.date.localeCompare(b.date);
    });

  // Airport chain is derived for UI breakdown only (still useful for
  // the result page even when some hops are train/drive).
  const airportChain: string[] = [];
  if (originFromQuiz && flightItems.length > 0) {
    airportChain.push(flightItems[0].from);
    for (const f of flightItems) airportChain.push(f.to);
  }

  let suggestedFlights: unknown = null;
  // Decide whether the parallel pre-search results are usable. Pre-
  // search only covered outbound + final return, so we can use it
  // directly when (a) we have results, (b) the itinerary has at most
  // two FLIGHT items (the standard bookends — no inter-leg flight
  // hops), and (c) the airports the itinerary picked match the ones
  // we predicted. Otherwise we ignore pre-search and run the full
  // FLIGHT-items-derived search — slower but always correct.
  const preSearchUsable =
    preSearch != null &&
    flightItems.length <= 2 &&
    (flightItems[0]?.to ?? preSearch.airports.first) === preSearch.airports.first;

  // Run the flight search when EITHER we have IATA-tagged FLIGHT items to
  // slice on, OR the parallel pre-search already returned offers. The
  // second case is critical for multi-leg trips: those synthesize flight
  // BOOKENDS with no IATA metadata (flightItems is empty), but the
  // pre-search (home → leg0, lastLeg → home) DID run off the resolved
  // origin + destination airports. Previously this block was gated on
  // flightItems.length > 0, so multi-leg trips silently dropped the live
  // "Pick your flight" offers even though we had them.
  const haveSomethingToSearch =
    (flightItems.length > 0 || (preSearch != null && preSearch.offers.length > 0)) &&
    constraints.startDate &&
    constraints.endDate;

  if (haveSomethingToSearch) {
    try {
      const groupSize = constraints.groupSize ?? 1;
      const result =
        preSearchUsable || flightItems.length === 0
          ? { ok: true as const, offers: preSearch?.offers ?? [] }
          : await searchFlights({
              // One Duffel slice per emitted FLIGHT item — same shape
              // whether it's a 2-flight round trip or a 3-flight multi-
              // city run.
              slices: flightItems.map((f) => ({
                origin: f.from,
                destination: f.to,
                departureDate: f.date,
              })),
              passengers: groupSize,
              cabin,
              maxOffers: 5,
            });
      if (preSearchUsable || flightItems.length === 0) {
        console.info("[build] using parallel pre-search results");
      }
      if (result.ok) {
        // Honor airline preference if the user picked one: re-sort so
        // the preferred carrier surfaces first when fares are close.
        // Duffel doesn't filter by airline server-side; this is purely
        // a UX bias on top of "cheapest" so the user gets their
        // airline if it's available without losing options.
        const preferred = (
          (parsed.data.answers.airlinePreference as string | undefined) ===
          "custom"
            ? ((parsed.data.answers.airlinePreferenceCustom as string | undefined) ?? "")
            : ((parsed.data.answers.airlinePreference as string | undefined) ?? "")
        ).toUpperCase();
        const offers =
          preferred && preferred !== "BEST_RATE"
            ? [...result.offers].sort((a, b) => {
                const aMatch = a.airlineIataCode.toUpperCase() === preferred ||
                  a.airlineName.toUpperCase().includes(preferred);
                const bMatch = b.airlineIataCode.toUpperCase() === preferred ||
                  b.airlineName.toUpperCase().includes(preferred);
                if (aMatch && !bMatch) return -1;
                if (!aMatch && bMatch) return 1;
                return a.totalAmount - b.totalAmount;
              })
            : result.offers;
        // Per-leg airport map for the UI breakdown. A leg whose hop
        // was train/drive shows airport: null so the result page can
        // render "Frecciarossa from Rome" instead of pretending there's
        // a flight in this segment.
        const legAirports = legs.map((_, i) => {
          const f = flightItems.find((fi) => fi.legIndex === i);
          return f?.to ?? null;
        });
        suggestedFlights = {
          fetchedAt: new Date().toISOString(),
          origin: originFromQuiz,
          destination: flightItems[0]?.to ?? preSearch?.airports.first ?? "",
          cabin,
          passengers: groupSize,
          offers: offers.slice(0, 3),
          legs: isMultiLeg
            ? legs.map((leg, i) => ({
                index: i,
                destination: leg.destination,
                airport: legAirports[i],
                startDate: leg.startDate,
                endDate: leg.endDate,
              }))
            : undefined,
          airportChain: isMultiLeg ? airportChain : undefined,
        };
        const existing =
          (
            await db.trip.findUnique({
              where: { id: tripId },
              select: { constraints: true },
            })
          )?.constraints ?? {};
        await db.trip.update({
          where: { id: tripId },
          data: {
            constraints: {
              ...(existing as Record<string, unknown>),
              suggestedFlights,
            } as object,
          },
        });

        // Replace the synthesized placeholder FLIGHT items in the
        // itinerary ("Flight to <destination>", "Return flight home from
        // <destination>") with REAL data from the best Duffel offer —
        // airline, exact airports, real departure/arrival times, per-
        // person cost. Customer now sees the same content in the
        // itinerary's Flights section as on the live "View & Book" card
        // up top, instead of two placeholder cards.
        try {
          await rewriteFlightItemsFromOffer({
            tripId,
            offer: offers[0],
            passengers: groupSize,
          });
        } catch (err) {
          console.warn("[build] couldn't rewrite flight items from offer:", err);
        }

        nudge(tripId);
      } else {
        console.warn(`[build] flight search returned error:`, result.error);
      }
    } catch (err) {
      // Flight search failure shouldn't break the build — the user
      // still has a full itinerary; they just won't see live flight
      // options on the result page.
      console.error("[build] flight search threw:", err);
    }
  } else {
    console.info(
      `[build] skipping flight search (origin=${originFromQuiz}, flightItems=${flightItems.length}, airports=${airportChain.join("→")}, dates=${constraints.startDate}/${constraints.endDate})`,
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      tripId,
      destination: chosenDestination,
      suggestedFlights,
      // Surface partial-success info from multi-leg fan-out so the UI can
      // show "we got 3 of 4 — couldn't plan Lake Como, refine and retry".
      partialLegFailures:
        partialLegFailures.length > 0 ? partialLegFailures : undefined,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Replace the synthesized placeholder FLIGHT items in the persisted
 * itinerary ("Flight to <destination>", "Return flight home from
 * <destination>") with REAL data from the chosen Duffel offer. After
 * this runs, the itinerary's Flights section shows the same airline +
 * airports + times + per-traveller price as the live "View & book" card.
 *
 * Matches items by metadata.segment ("outbound" / "return") when present,
 * otherwise by chronological order. No-ops cleanly if the items shape
 * is unexpected — flight cards just stay as their placeholder text.
 */
async function rewriteFlightItemsFromOffer(args: {
  tripId: string;
  offer: import("@/lib/bookings/providers/duffel-search").FlightOfferSummary;
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

  const fmtDuration = (mins: number): string => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  // Map outbound + return by metadata.segment when set, else positional.
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
      // Position-based fallback when segment metadata is missing.
      const idx = flightItems.indexOf(item);
      slice = idx === 0 ? outbound : returnSlice;
    }
    if (!slice) continue;

    const title = `${offer.airlineName} · ${slice.origin} → ${slice.destination}`;
    const stopsLabel = slice.stops === 0 ? "nonstop" : `${slice.stops} stop`;
    const description = `${slice.origin} ${formatTime(slice.departing)} → ${slice.destination} ${formatTime(slice.arriving)} · ${fmtDuration(slice.durationMinutes)} · ${stopsLabel} · ${formatCabin(slice.cabin)}`;
    const startTime = parseIsoDate(slice.departing);
    const endTime = parseIsoDate(slice.arriving);
    // Per-pax × passengers, in cents — same shape as priced items.
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

/**
 * Translate the raw error from a failed itinerary build into a single
 * humane sentence. NEVER returns a Zod dump, JSON, stack trace, or any
 * other developer-facing string — those go to the terminal only.
 */
function friendlyBuildError(rawMsg: string): string {
  const msg = (rawMsg ?? "").toLowerCase();
  if (msg.includes("truncated at max_tokens") || msg.includes("too large")) {
    return "This trip was a bit too much for one pass. Try fewer destinations or a shorter window — your answers are saved.";
  }
  if (
    msg.includes("schema validation failed") ||
    msg.includes("did not return a tool_use") ||
    msg.includes("invalid_type")
  ) {
    return "We hit a hiccup on the planning step. Tap retry — it usually goes through on the second try. Your answers are saved.";
  }
  if (
    msg.includes("overloaded") ||
    msg.includes("rate_limit") ||
    msg.includes("429") ||
    msg.includes("529")
  ) {
    return "The planner is briefly overloaded. Give it a minute and tap retry — your answers are saved.";
  }
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("aborterror")) {
    return "Planning took longer than usual. Tap retry, or simplify the request if you asked for many destinations at once.";
  }
  return "We couldn't finish your itinerary. Your details are saved — tap retry to try again.";
}

/**
 * Detect inputs that are HINTS rather than specific bookable places.
 * "a course in Italy", "somewhere warm", "Spain", "links course" — these
 * should route through the destination agent, not be jammed straight
 * into the itinerary agent (which expects a known place name).
 *
 * Returns true for hint-style inputs so the caller knows to run the
 * destination agent with the hint as context.
 */
function looksLikeHintNotPlace(d: string): boolean {
  const s = d.toLowerCase().trim();
  if (s.length < 3) return true;
  // Phrases that signal a hint, not a place.
  const phrasePatterns: RegExp[] = [
    /\bcourse(s)?\s+in\b/, // "course in Italy"
    /\bsomewhere\b/,
    /\banywhere\b/,
    /\bany\s+(course|place|where)\b/,
    /\bbest\s+(course|place|spot|destination|golf)\b/,
    /\b(play|find)\s+(golf|a\s+round|courses?)\b/,
    /\b(warm|sunny|hot|cold|cheap|luxury|nice|good|great)\b(?!\s+[A-Z][a-z])/, // adjectives unless followed by a Proper Noun
    /^\s*(a|an|the)\s+\w+(\s+\w+)?\s*$/, // "a links course", "the desert", "an island" — articles + 1-2 words usually = hint
  ];
  if (phrasePatterns.some((p) => p.test(s))) return true;
  // Bare country / region names that aren't a specific resort
  const bareRegions = new Set([
    "italy",
    "spain",
    "france",
    "portugal",
    "scotland",
    "ireland",
    "england",
    "uk",
    "germany",
    "switzerland",
    "mexico",
    "caribbean",
    "hawaii",
    "europe",
    "asia",
    "africa",
    "south america",
    "north america",
    "florida",
    "california",
    "arizona",
    "texas",
    "north carolina",
    "south carolina",
    "georgia",
    "tennessee",
    "virginia",
    "colorado",
    "oregon",
    "washington",
    "new york",
    "michigan",
    "wisconsin",
    "vermont",
    "maine",
  ]);
  if (bareRegions.has(s)) return true;
  return false;
}
