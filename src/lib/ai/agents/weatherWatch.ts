import { db } from "@/lib/db";
import {
  findDestination,
  monthFromDate,
  weatherFitForMonth,
} from "@/lib/data/destinations";
import { nudge } from "@/lib/events";

/**
 * The weather watch agent. Runs on a daily cron — checks every active trip
 * whose dates fall in the "poor" weather window for its destination and
 * (a) writes a notification to the owner, and (b) prepends a concierge
 * message recommending a date shift or destination swap. Cheap and grounded
 * — no AI call needed since the KB tells us per-month fitness.
 */
export async function runWeatherWatchForAllTrips() {
  const trips = await db.trip.findMany({
    where: {
      status: { in: ["DRAFT", "PLANNING", "AWAITING_APPROVAL", "APPROVED"] },
      destination: { not: null },
      startDate: { not: null, gt: new Date() },
    },
    include: {
      members: { where: { role: "OWNER" }, take: 1, select: { userId: true } },
    },
  });

  let nudged = 0;
  for (const trip of trips) {
    if (!trip.destination || !trip.startDate) continue;
    const kb = findDestination(trip.destination);
    if (!kb) continue;
    const month = monthFromDate(trip.startDate);
    if (!month) continue;
    const w = weatherFitForMonth(kb, month);
    if (w.rating !== "poor") continue;

    const recentSimilar = await db.notification.findFirst({
      where: {
        tripId: trip.id,
        type: "SYSTEM",
        title: { startsWith: "Weather warning" },
        createdAt: { gt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7) },
      },
    });
    if (recentSimilar) continue;

    const ownerUserId = trip.members[0]?.userId;
    if (ownerUserId) {
      await db.notification.create({
        data: {
          tripId: trip.id,
          userId: ownerUserId,
          type: "SYSTEM",
          title: `Weather warning · ${trip.destination} in ${month}`,
          message: `${w.note}. Worth shifting dates 2–4 weeks or picking an alternative — say the word.`,
        },
      });
    }
    await db.chatMessage.create({
      data: {
        tripId: trip.id,
        role: "ASSISTANT",
        content: `Quick flag on weather: ${trip.destination} in ${month} is typically ${w.rating} — ${w.note}. Want me to shift the dates, or look at an alternative for the same window?`,
        metadata: { kind: "weather_watch" },
      },
    });
    nudge(trip.id);
    nudged++;
  }
  return { tripsChecked: trips.length, nudged };
}
