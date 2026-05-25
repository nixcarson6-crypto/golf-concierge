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

  // Step 2: itinerary. One pass, no refinement loop. The result screen
  // exposes edit buttons for tweaks — those go through a smaller targeted
  // endpoint, not the full agent. Wrapped so a malformed AI response
  // or schema validation failure surfaces the actual reason to the
  // client instead of crashing the whole build with a bare 500.
  let itineraryOutput;
  try {
    const run = await runItineraryAgent({
      tripId,
      destination: chosenDestination,
      constraints: itineraryConstraints,
      priorItinerary: null,
    });
    itineraryOutput = run.output;
    await persistItinerary(tripId, itineraryOutput);
    nudge(tripId);
  } catch (err) {
    console.error("[build] itinerary step failed:", err);
    const rawMsg = err instanceof Error ? err.message : String(err);
    // Map the internal truncation marker to plain English. The user
    // doesn't need to see "[runStructured:emit_itinerary] response
    // truncated at max_tokens" — that's debugging noise.
    const userMsg = rawMsg.includes("truncated at max_tokens")
      ? "This trip is more complex than we could fit in one pass. Try fewer destinations, a shorter trip, or simpler preferences and retry."
      : `Couldn't build the itinerary: ${rawMsg}. Your trip details were saved — try again or simplify the request.`;
    return new Response(
      JSON.stringify({ error: userMsg }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Step 3: run a live flight search so the result page can show real
  // bookable options. We use the user's quiz-supplied origin airport
  // and pull the destination IATA from whichever FLIGHT item the
  // itinerary agent emitted (it's instructed to set metadata.to). If
  // we can't determine a destination airport we skip — the rest of the
  // plan is still useful.
  const answers = parsed.data.answers;
  // Origin airport: handle the free-text "custom" path defensively —
  // users may type "AUS", "aus", " aus ", "Austin", or "p d x". Trim,
  // uppercase, and only accept exactly 3 alpha chars (an IATA code).
  // Anything else falls through to skipping the flight search rather
  // than searching DFW→AUSTIN and getting nothing.
  const rawOrigin =
    (answers.originAirport as string | undefined) === "custom"
      ? ((answers.originAirportCustom as string | undefined) ?? "")
      : ((answers.originAirport as string | undefined) ?? "");
  const cleanedOrigin = rawOrigin.replace(/\s+/g, "").toUpperCase();
  const originFromQuiz = /^[A-Z]{3}$/.test(cleanedOrigin) ? cleanedOrigin : "";
  // Cabin: if the user picked "Best rate" on the airline question we
  // skipped the cabin screen entirely — default to economy (the
  // cheapest option) so the flight search honors their "I don't care,
  // cheapest please" intent end-to-end.
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

  // Build flight search slices. For single-leg trips that's the
  // familiar 2-slice out+back. For multi-leg trips we construct N+1
  // slices: home → leg0 → leg1 → ... → home. We rely on the itinerary
  // agent to have emitted FLIGHT items with metadata.to/from set per
  // segment; if any segment is missing an IATA, we skip flight search
  // and surface a warning instead of crashing.
  const flightItems = itineraryOutput.items.filter((it) => it.type === "FLIGHT");
  // Build the airport chain: [home, leg0_airport, leg1_airport, ..., home].
  const airportChain: string[] = [];
  let chainOk = true;
  if (originFromQuiz && originFromQuiz.length === 3) {
    airportChain.push(originFromQuiz);
    for (let i = 0; i < legs.length; i++) {
      // Find a FLIGHT item whose metadata.legIndex matches OR fall back
      // to the i-th FLIGHT item in order.
      const matched =
        flightItems.find((it) => {
          const meta = (it.metadata ?? {}) as { legIndex?: number };
          return meta.legIndex === i;
        }) ?? flightItems[i];
      const meta = (matched?.metadata ?? {}) as { to?: string; from?: string };
      const to = (meta.to ?? "").toUpperCase();
      if (to && to.length === 3) {
        airportChain.push(to);
      } else {
        chainOk = false;
        break;
      }
    }
    airportChain.push(originFromQuiz);
  } else {
    chainOk = false;
  }

  let suggestedFlights: unknown = null;
  if (chainOk && constraints.startDate && constraints.endDate) {
    try {
      const groupSize = constraints.groupSize ?? 1;
      // Slice 0: home → leg0 on leg0.startDate
      // Slice i (1..N-1): leg(i-1) → legi on legi.startDate
      // Slice N: leg(N-1) → home on lastLeg.endDate
      const slices = [];
      for (let i = 0; i < legs.length; i++) {
        slices.push({
          origin: airportChain[i],
          destination: airportChain[i + 1],
          departureDate: legs[i].startDate,
        });
      }
      slices.push({
        origin: airportChain[airportChain.length - 2],
        destination: airportChain[airportChain.length - 1],
        departureDate: legs[legs.length - 1].endDate,
      });

      const result = await searchFlights({
        slices,
        passengers: groupSize,
        cabin,
        maxOffers: 5,
      });
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
        // Keep top 3 — enough for choice without analysis paralysis.
        // For multi-leg, origin/destination describe the FIRST hop only;
        // the full airport chain lives in airportChain so the UI can
        // render a per-leg breakdown later.
        suggestedFlights = {
          fetchedAt: new Date().toISOString(),
          origin: originFromQuiz,
          destination: airportChain[1] ?? "",
          cabin,
          passengers: groupSize,
          offers: offers.slice(0, 3),
          legs: isMultiLeg
            ? legs.map((leg, i) => ({
                index: i,
                destination: leg.destination,
                airport: airportChain[i + 1] ?? null,
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
      `[build] skipping flight search (origin=${originFromQuiz}, chainOk=${chainOk}, airports=${airportChain.join("→")}, dates=${constraints.startDate}/${constraints.endDate})`,
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      tripId,
      destination: chosenDestination,
      suggestedFlights,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
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
