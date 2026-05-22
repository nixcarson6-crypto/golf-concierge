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
import { persistItinerary, autoTitle } from "@/lib/ai/conversation";
import { nudge } from "@/lib/events";

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

  const constraints = quizAnswersToConstraints(parsed.data.answers);
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

  return new Response(
    JSON.stringify({
      ok: true,
      tripId,
      destination: chosenDestination,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
