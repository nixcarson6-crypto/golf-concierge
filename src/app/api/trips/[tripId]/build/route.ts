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
import { rewriteFlightItemsFromOffer } from "@/lib/flights/rewrite-items";
import { stripLocationSuffix } from "@/lib/trip-display";

const bodySchema = z.object({
  answers: z.record(z.string(), z.unknown()),
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
  // ALWAYS preserve the user's original phrasing in notes when cleaning
  // changed it. The cleaner strips "and stay at the Aman" to get the place
  // name — but that clause names the REQUIRED hotel, and dropping it sent a
  // customer who asked for the Aman to One&Only Portonovi. The itinerary
  // agent must see the raw words.
  const cleaningDroppedWords =
    rawDest.length > 0 &&
    cleanedPrimary != null &&
    rawDest.toLowerCase() !== cleanedPrimary.toLowerCase();
  const originalPhrasingNote = looksMultiDest
    ? `Multi-destination request — user originally wrote: "${rawDest}". Plan a multi-leg trip respecting the split they described. Primary destination for downstream APIs is "${cleanedPrimary ?? rawDest}".`
    : cleaningDroppedWords
      ? `User originally wrote: "${rawDest}". If this names a specific hotel/resort/lodge (e.g. "the Aman", "St. Regis", "stay at X"), that EXACT property is the REQUIRED lodging — do not substitute any other hotel. Honor any other specifics in it (courses, vibe, who's coming).`
      : null;
  const constraints = {
    ...rawConstraints,
    destination: cleanedPrimary,
    notes: originalPhrasingNote
      ? `${originalPhrasingNote} ${rawConstraints.notes ?? ""}`.trim()
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
      // Strip the AI's " in [city]" / ", [region]" suffix from every
      // leg so display + downstream lookups all see just the venue name.
      legs = withDates.map((l) => ({
        ...l,
        destination: stripLocationSuffix(l.destination),
      }));
      chosenDestination = legs[0].destination;
      // Update the primary trip destination AND title to leg 0 for the
      // header. Title is force-set (not gated on placeholder) so even
      // when the user typed a conversational sentence ("the top-rated
      // course in Tennessee, if they have a resort…") the header
      // shows the resolved leg name, never the raw input.
      await db.trip.update({
        where: { id: tripId },
        data: { destination: chosenDestination, title: chosenDestination },
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
      // We use cleanedPrimary (which is null when the input was
      // conversational) for the "useDirectly" check, but we fall back
      // to the RAW user input as a hint for the destination agent.
      // Without this, typing "the top-rated course in Tennessee"
      // would lose the Tennessee + top-rated hints entirely once
      // cleanDestination rejected the sentence, and the agent would
      // pick from nowhere in particular.
      const userTyped = constraints.destination?.trim() ?? "";
      const rawHint = rawDest && rawDest !== userTyped ? rawDest : "";
      const useDirectly =
        userTyped.length > 0 && !looksLikeHintNotPlace(userTyped);

      if (useDirectly) {
        chosenDestination = stripLocationSuffix(userTyped);
        // Sync trip.title to the typed destination so the header reads
        // "Pinehurst" instead of "Untitled trip".
        await db.trip.update({
          where: { id: tripId },
          data: { title: chosenDestination },
        });
      } else {
        // Pass the user's hint to the agent — whichever survived. Prefer
        // the cleaned form (a real-ish phrase) but fall back to the raw
        // input so the agent still sees "the top-rated course in
        // Tennessee" even though cleanDestination rejected the sentence.
        const hintForAgent = userTyped || rawHint;
        const constraintsForAgent = hintForAgent
          ? {
              ...constraints,
              destination: null,
              notes: `User's destination hint: "${hintForAgent}". NON-NEGOTIABLE: if this hint names a real place (a country, region, island, or city — e.g. "Montenegro", "Tuscany", "Tennessee"), every option you return MUST be IN that place. Never substitute a different country/region because its golf scene is small — find the best golf that actually exists there. Only pick freely when the hint names no place at all. ${constraints.notes ?? ""}`.trim(),
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
        // Strip the AI's habit of appending " in [city]" / ", [region]"
        // to venue names — Carson wants just "Fields Ranch", never
        // "Fields Ranch in Frisco". Same helper used at the display
        // layer so a stale row from before this fix still renders clean.
        chosenDestination = stripLocationSuffix(top.name);
        await db.trip.update({
          where: { id: tripId },
          data: { destination: chosenDestination, title: chosenDestination },
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
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[build] DESTINATION STEP FAILED — root cause: ${rawMsg.slice(0, 500)}`,
    );
    console.error("[build] full stack:", err);
    // Run through friendlyBuildError so model glitches at the
    // destination stage get the same humane copy as itinerary glitches
    // (currently they leak the raw 'Destination step failed: ...').
    return new Response(
      JSON.stringify({ error: friendlyBuildError(rawMsg) }),
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
  let originFromQuiz = /^[A-Z]{3}$/.test(cleanedOrigin)
    ? cleanedOrigin
    : rawOrigin
      ? (await airportForDestination(rawOrigin)) ?? ""
      : "";
  // Sticky home airport: if the quiz didn't capture an origin, fall back
  // to whatever the user picked on a previous trip (saved on the User row
  // by this same code path and by the SetOriginBanner). This is why a
  // returning customer never sees the "Set your home airport" banner
  // again — the choice persists.
  if (!originFromQuiz) {
    const saved = await db.user.findUnique({
      where: { id: user.id },
      select: { defaultOriginAirport: true },
    });
    if (saved?.defaultOriginAirport && /^[A-Z]{3}$/.test(saved.defaultOriginAirport)) {
      originFromQuiz = saved.defaultOriginAirport;
    }
  }
  // Conversely, when we DID get an origin (from the quiz OR the user's
  // saved profile), persist it back to the user row so the next trip
  // starts pre-filled. Unconditional update — we WANT the most recent
  // typed/used airport to be the sticky one (overwrite stale values).
  // No `void`/silent catch — a failure here is the root cause of the
  // "Set your home airport" banner reappearing, so we log it loudly.
  if (originFromQuiz) {
    try {
      await db.user.update({
        where: { id: user.id },
        data: { defaultOriginAirport: originFromQuiz },
      });
      console.log(
        `[build] Saved defaultOriginAirport=${originFromQuiz} for user ${user.id}.`,
      );
    } catch (err) {
      console.error(
        `[build] FAILED to save defaultOriginAirport for user ${user.id}:`,
        err,
      );
    }
  }
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
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Print a tagged single-line summary so it's grep-able in the dev
    // terminal, THEN the full stack below. Without the tagged line it's
    // way too easy to miss the root cause inside a wall of stack noise.
    console.error(
      `[build] ITINERARY STEP FAILED — root cause: ${rawMsg.slice(0, 500)}`,
    );
    console.error("[build] full stack:", err);
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

  // DEDUPE: kill any duplicate (from, to, date) hops the AI emitted (e.g.
  // 3 identical LIM→DFW return items for a 3-person trip). Without this,
  // the Duffel search returns N identical slices and the rewriter
  // produces N identical flight cards. Order preserved.
  const seen = new Set<string>();
  const dedupedFlightItems = flightItems.filter((f) => {
    const key = `${f.from}->${f.to}@${f.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (dedupedFlightItems.length !== flightItems.length) {
    console.warn(
      `[build] dropped ${flightItems.length - dedupedFlightItems.length} duplicate FLIGHT slice(s) — AI emitted ${flightItems.length}, kept ${dedupedFlightItems.length}.`,
    );
  }
  // FORCE TRIP DATES: the AI sometimes slips bookend flights by a day or
  // two ("buffer"); the trip dates are the customer's exact in-destination
  // dates and the flights MUST bookend them. Snap the outbound (first
  // hop) to startDate and the final return (last hop) to endDate. Inter-
  // leg dates are kept as-is — those are determined by the itinerary.
  if (dedupedFlightItems.length > 0 && constraints.startDate) {
    if (dedupedFlightItems[0].date !== constraints.startDate) {
      console.info(
        `[build] snapping outbound flight date ${dedupedFlightItems[0].date} → trip startDate ${constraints.startDate}.`,
      );
      dedupedFlightItems[0] = { ...dedupedFlightItems[0], date: constraints.startDate };
    }
  }
  if (dedupedFlightItems.length > 1 && constraints.endDate) {
    const lastIdx = dedupedFlightItems.length - 1;
    if (dedupedFlightItems[lastIdx].date !== constraints.endDate) {
      console.info(
        `[build] snapping return flight date ${dedupedFlightItems[lastIdx].date} → trip endDate ${constraints.endDate}.`,
      );
      dedupedFlightItems[lastIdx] = { ...dedupedFlightItems[lastIdx], date: constraints.endDate };
    }
  }
  flightItems.length = 0;
  flightItems.push(...dedupedFlightItems);

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
  // The pre-search computed the home→leg0 outbound (+ final→home return)
  // anchored to the RESOLVED origin (e.g. BOS) — exactly what the "Pick your
  // flight" card needs. Use it whenever the itinerary's OWN flight items
  // don't already model that outbound-from-origin bookend.
  //
  // BUG THIS FIXES (multi-leg trips, e.g. Croatia DBV→SPU→PUY): the
  // synthesized US↔Croatia bookends carry no IATA metadata, so they get
  // filtered out of flightItems (the filter requires valid 3-letter codes),
  // leaving ONLY the inter-leg hops. The old check —
  // flightItems[0].to === preSearch.airports.first — then failed (the first
  // surviving item goes to Split, not Dubrovnik), so we discarded the good
  // BOS-anchored offers and searched just the tiny inter-leg hops, which
  // return nothing → the "Set your home airport" banner reappeared with the
  // origin sitting right there. Anchoring on "does the itinerary already
  // model the outbound from origin?" is what actually matters.
  const itineraryHasOutboundFromOrigin = flightItems.some(
    (f) => f.from === originFromQuiz,
  );
  const preSearchUsable =
    preSearch != null &&
    preSearch.offers.length > 0 &&
    !itineraryHasOutboundFromOrigin;

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
          // When we're showing the pre-search offers (home→leg0), the
          // destination label is leg0's airport — NOT flightItems[0], which
          // on a multi-leg trip is an inter-leg hop (e.g. →Split).
          destination: preSearchUsable
            ? (preSearch?.airports.first ?? "")
            : (flightItems[0]?.to ?? preSearch?.airports.first ?? ""),
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

  // Real-price enrichment: look up actual published hotel + green-fee
  // rates (web search, source-gated) and compute real Uber fares from
  // Google driving distance. Anything we can't confirm stays null.
  // Non-fatal — a full itinerary with flight prices is already useful;
  // the rest of the prices pop in when this finishes + nudges.
  try {
    const { enrichItineraryPrices } = await import(
      "@/lib/ai/agents/price-enrichment"
    );
    const { enriched } = await enrichItineraryPrices(tripId, {
      groupSize: constraints.groupSize ?? 2,
      destination: chosenDestination,
    });
    console.log(`[build] price-enrichment confirmed ${enriched} real prices.`);
    if (enriched > 0) nudge(tripId);
  } catch (err) {
    console.error("[build] price-enrichment threw (non-fatal):", err);
  }

  // Walk-in classification: tag DINING / ACTIVITY items as
  // 'required' / 'walk_in' / 'unknown' using Google's `reservable`
  // attribute. Lets the UI label casual venues as "walk-in" and stops
  // the agent from wasting time trying to book them.
  try {
    const { classifyTripReservations } = await import(
      "@/lib/ai/agents/classify-reservations"
    );
    const { classified, walkIns } = await classifyTripReservations(tripId);
    if (classified > 0) {
      console.log(
        `[build] classify-reservations: ${walkIns} walk-in of ${classified} classified.`,
      );
      nudge(tripId);
    }
  } catch (err) {
    console.error("[build] classify-reservations threw (non-fatal):", err);
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
