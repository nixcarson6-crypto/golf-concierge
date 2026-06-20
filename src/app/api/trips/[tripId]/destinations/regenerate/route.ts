import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { runDestinationAgent } from "@/lib/ai/agents/destination";
import type { TripConstraints } from "@/lib/ai/schemas";
import { nudge } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const constraints = (trip.constraints as TripConstraints | null) ?? {};
  // A re-roll should hand back DIFFERENT options than what's already on
  // screen — otherwise "regenerate" / "show me top 3" feels broken. Treat a
  // trip with no specific named destination as open-ended (inject the
  // variety shortlist) and tell the agent to avoid everything already shown
  // plus the current pick.
  const named =
    typeof constraints.destination === "string" &&
    constraints.destination.trim().length > 0;
  const shown = await db.destinationOption.findMany({
    where: { tripId },
    select: { name: true },
  });
  const avoidDestinations = [
    ...new Set(
      [...shown.map((s) => s.name), trip.destination ?? ""].filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      ),
    ),
  ];
  const { output } = await runDestinationAgent({
    tripId,
    constraints,
    variety: !named,
    avoidDestinations,
  });

  await db.$transaction([
    db.destinationOption.deleteMany({ where: { tripId } }),
    db.destinationOption.createMany({
      data: output.options.map((o, i) => ({
        tripId,
        name: o.name,
        description: o.description,
        heroImageUrl: o.heroImageUrl,
        golfScore: o.golfScore,
        nightlifeScore: o.nightlifeScore,
        weatherSummary: o.weatherSummary,
        lodgingEstimate: o.lodgingEstimate,
        logisticsScore: o.logisticsScore,
        estimatedTotalCost: o.estimatedTotalCost * 100,
        estimatedPerPersonCost: o.estimatedPerPersonCost * 100,
        aiExplanation: o.aiExplanation,
        rank: i,
      })),
    }),
  ]);
  nudge(tripId);

  return NextResponse.json({ ok: true, count: output.options.length });
}
