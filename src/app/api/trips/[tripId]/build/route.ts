/**
 * Quiz → trip build pipeline. Takes the answers from the Hungry Root-
 * style intake, maps them to TripConstraints, and runs the destination
 * + itinerary agents ONCE to produce a complete plan. No streaming, no
 * agentic loops — the per-trip API cost is bounded to two model calls.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
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

const bodySchema = z.object({
  answers: z.record(z.unknown()),
});

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
  const constraints = {
    ...rawConstraints,
    destination: cleanDestination(rawConstraints.destination),
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

  // Step 1: destination. If the user supplied a specific destination,
  // skip the agent and use it directly — saves one model call.
  let chosenDestination: string;
  if (constraints.destination && constraints.destination.trim().length > 0) {
    chosenDestination = constraints.destination.trim();
  } else {
    const destRun = await runDestinationAgent({ tripId, constraints });
    const top = destRun.output.options[0];
    if (!top) {
      return new Response(
        JSON.stringify({ error: "Couldn't generate destination options." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    chosenDestination = top.name;
    // Persist the proposed destinations + lock in the top pick as the
    // trip's destination.
    await db.trip.update({
      where: { id: tripId },
      data: { destination: chosenDestination },
    });
    nudge(tripId);
  }

  // Step 2: itinerary. One pass, no refinement loop. The result screen
  // exposes edit buttons for tweaks — those go through a smaller targeted
  // endpoint, not the full agent.
  const { output: itineraryOutput } = await runItineraryAgent({
    tripId,
    destination: chosenDestination,
    constraints,
    priorItinerary: null,
  });
  await persistItinerary(tripId, itineraryOutput);
  nudge(tripId);

  // Step 3: run a live flight search so the result page can show real
  // bookable options. We use the user's quiz-supplied origin airport
  // and pull the destination IATA from whichever FLIGHT item the
  // itinerary agent emitted (it's instructed to set metadata.to). If
  // we can't determine a destination airport we skip — the rest of the
  // plan is still useful.
  const answers = parsed.data.answers;
  const originFromQuiz =
    (answers.originAirport as string | undefined) === "custom"
      ? ((answers.originAirportCustom as string | undefined) ?? "").toUpperCase()
      : ((answers.originAirport as string | undefined) ?? "").toUpperCase();
  const cabinAnswer = (answers.cabinClass as string | undefined) ?? "business";
  const cabin: "first" | "business" | "premium_economy" | "economy" =
    cabinAnswer === "first"
      ? "first"
      : cabinAnswer === "premium_economy"
        ? "premium_economy"
        : cabinAnswer === "economy" || cabinAnswer === "best_deal"
          ? "economy"
          : "business";

  // Look for a destination IATA on any FLIGHT item the AI just emitted.
  const flightItem = itineraryOutput.items.find((it) => it.type === "FLIGHT");
  const flightMeta = (flightItem?.metadata ?? {}) as {
    to?: string;
    from?: string;
  };
  const destinationIATA = (flightMeta.to ?? "").toUpperCase();

  let suggestedFlights: unknown = null;
  if (
    originFromQuiz &&
    originFromQuiz.length === 3 &&
    destinationIATA &&
    destinationIATA.length === 3 &&
    constraints.startDate &&
    constraints.endDate
  ) {
    try {
      const groupSize = constraints.groupSize ?? 1;
      const result = await searchFlights({
        slices: [
          {
            origin: originFromQuiz,
            destination: destinationIATA,
            departureDate: constraints.startDate,
          },
          {
            origin: destinationIATA,
            destination: originFromQuiz,
            departureDate: constraints.endDate,
          },
        ],
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
        suggestedFlights = {
          fetchedAt: new Date().toISOString(),
          origin: originFromQuiz,
          destination: destinationIATA,
          cabin,
          passengers: groupSize,
          offers: offers.slice(0, 3),
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
      `[build] skipping flight search (origin=${originFromQuiz}, dest=${destinationIATA}, dates=${constraints.startDate}/${constraints.endDate})`,
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
