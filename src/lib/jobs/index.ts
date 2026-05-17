import { inngest } from "../inngest";
import { executeItineraryBookings } from "../bookings/executor";
import { db } from "../db";
import { runItineraryAgent } from "../ai/agents/itinerary";
import { runSummaryAgent } from "../ai/agents/summary";
import type { ItineraryAI, TripConstraints } from "../ai/schemas";

/**
 * Background workers. Each is a single Inngest function so it can retry
 * independently. Triggers are domain events (`trip/itinerary.approved` etc.)
 * — never raw HTTP — so route handlers stay short and synchronous.
 */

export const onItineraryApproved = inngest.createFunction(
  { id: "itinerary-approved-book-everything" },
  { event: "trip/itinerary.approved" },
  async ({ event }) => {
    await executeItineraryBookings(event.data.itineraryId);
  },
);

export const onRefineRequested = inngest.createFunction(
  { id: "itinerary-refine" },
  { event: "trip/itinerary.refine_requested" },
  async ({ event }) => {
    const { tripId, instruction } = event.data;
    const trip = await db.trip.findUnique({
      where: { id: tripId },
      include: {
        itineraries: {
          where: { status: "CURRENT" },
          include: { items: true },
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });
    if (!trip || !trip.destination) return;

    const current = trip.itineraries[0];
    const prior: ItineraryAI | null = current
      ? {
          summary: current.aiSummary ?? "",
          totalCost: Math.round((current.totalCost ?? 0) / 100),
          perPersonCost: Math.round((current.perPersonCost ?? 0) / 100),
          items: current.items.map((i) => ({
            type: i.type,
            title: i.title,
            description: i.description ?? null,
            location: i.location ?? null,
            address: i.address ?? null,
            startTime: i.startTime?.toISOString() ?? null,
            endTime: i.endTime?.toISOString() ?? null,
            cost: i.cost ? Math.round(i.cost / 100) : null,
            aiRationale: i.aiRationale ?? null,
            metadata: (i.metadata as Record<string, unknown>) ?? null,
          })),
          changes: [],
        }
      : null;

    await runItineraryAgent({
      tripId,
      destination: trip.destination,
      constraints: (trip.constraints as TripConstraints) ?? {},
      priorItinerary: prior,
      refinementInstruction: instruction,
    });
  },
);

export const onSummaryRequested = inngest.createFunction(
  { id: "summary-generate" },
  { event: "trip/summary.generate_requested" },
  async ({ event }) => {
    const trip = await db.trip.findUnique({
      where: { id: event.data.tripId },
      include: {
        itineraries: {
          where: { status: "APPROVED" },
          orderBy: { version: "desc" },
          take: 1,
          include: { items: { include: { booking: true } } },
        },
      },
    });
    if (!trip) return;
    const it = trip.itineraries[0];
    if (!it) return;

    const summary = await runSummaryAgent({
      tripId: trip.id,
      context: {
        title: trip.title,
        destination: trip.destination,
        startDate: trip.startDate?.toISOString() ?? null,
        endDate: trip.endDate?.toISOString() ?? null,
        groupSize: trip.groupSize,
        totalCost: it.totalCost,
        perPersonCost: it.perPersonCost,
        items: it.items.map((i) => ({
          type: i.type,
          title: i.title,
          startTime: i.startTime?.toISOString() ?? null,
          cost: i.cost,
          status: i.status ?? null,
          confirmationCode: i.booking?.confirmationCode ?? null,
        })),
        substitutions: ((it.diff as { changes?: string[] } | null)?.changes) ?? [],
      },
    });

    await db.tripSummary.upsert({
      where: { tripId: trip.id },
      create: {
        tripId: trip.id,
        itineraryId: it.id,
        content: summary.content,
        highlights: { items: summary.highlights, substitutions: summary.substitutions },
        totalCost: it.totalCost,
        perPersonCost: it.perPersonCost,
      },
      update: {
        itineraryId: it.id,
        content: summary.content,
        highlights: { items: summary.highlights, substitutions: summary.substitutions },
        totalCost: it.totalCost,
        perPersonCost: it.perPersonCost,
        generatedAt: new Date(),
      },
    });
  },
);

export const functions = [
  onItineraryApproved,
  onRefineRequested,
  onSummaryRequested,
];
