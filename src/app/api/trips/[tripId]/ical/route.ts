import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { tripToIcal } from "@/lib/ical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return new Response("not found", { status: 404 });

  const itinerary = await db.itinerary.findFirst({
    where: { tripId, status: { in: ["CURRENT", "APPROVED"] } },
    orderBy: { version: "desc" },
    include: { items: { orderBy: { orderIndex: "asc" } } },
  });
  if (!itinerary) return new Response("no itinerary", { status: 404 });

  const ical = tripToIcal({ trip, items: itinerary.items });
  return new Response(ical, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${trip.title.replace(/[^a-z0-9-]+/gi, "-")}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
