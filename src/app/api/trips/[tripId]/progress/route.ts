import { NextResponse } from "next/server";
import { db, withDbRetry } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ultra-light build-progress endpoint.
 *
 * The quiz loading screen polls this every few seconds while a trip builds.
 * It used to poll the full `/workspace` snapshot (~11 DB queries) which, on
 * a slow connection, fought the in-flight build for the small Neon pool and
 * made everything crawl (and sometimes 500 the build page). This does ONE
 * ownership-scoped query for the latest agent-run progress — so the build
 * keeps the connection pool to itself.
 *
 * Returns `{ progress, agentStatus, hasItinerary }`. Auth is enforced via
 * the relation filter (trip.ownerId) so a single query both checks access
 * and reads progress.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const me = await requireUser();
  const { tripId } = await params;

  try {
    const run = await withDbRetry(
      () =>
        db.agentRun.findFirst({
          where: { tripId, trip: { ownerId: me.id } },
          orderBy: { createdAt: "desc" },
          select: { status: true, progress: true },
        }),
      "progress.agentRun",
    );

    // Cheap existence check for an itinerary so the loading screen can tell
    // when generation has actually landed (one indexed query, no joins).
    const itinerary = await withDbRetry(
      () =>
        db.itinerary.findFirst({
          where: { tripId, status: { in: ["DRAFT", "CURRENT", "APPROVED"] } },
          select: { id: true },
        }),
      "progress.itinerary",
    );

    return NextResponse.json(
      {
        progress: run?.progress ?? null,
        agentStatus: run?.status ?? null,
        hasItinerary: Boolean(itinerary),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Never let a transient DB hiccup surface as an error to the poller —
    // the loading screen just falls back to its rotating placeholder text.
    return NextResponse.json(
      { progress: null, agentStatus: null, hasItinerary: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
