import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { approveItinerary } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Owner-only fast approve. Skips quorum and triggers the full workflow.
 * Useful when the owner is acting on the group's behalf.
 */
export async function POST(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ tripId: string; itineraryId: string }>;
  },
) {
  const user = await requireUser();
  const { tripId, itineraryId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const itinerary = await db.itinerary.findFirst({
    where: { id: itineraryId, tripId, status: "CURRENT" },
  });
  if (!itinerary) {
    return NextResponse.json({ error: "no current itinerary" }, { status: 404 });
  }

  // Mark all group members APPROVED on the owner's say-so.
  await db.tripMember.updateMany({
    where: { tripId },
    data: { approvalStatus: "APPROVED" },
  });

  await approveItinerary({ tripId, itineraryId, userId: user.id });

  return NextResponse.json({ ok: true });
}
