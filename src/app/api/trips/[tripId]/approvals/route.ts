import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { approveItinerary } from "@/lib/workflow";
import { nudge } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "DECLINED"]),
  itineraryId: z.string(),
});

/**
 * Per-member approval. The first approval also marks the trip
 * AWAITING_APPROVAL. Once a quorum (≥ 2/3 of members, or all if ≤ 3) has
 * approved, the workflow auto-runs — no extra owner click needed.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const user = await requireUser();
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new NextResponse("invalid body", { status: 400 });

  const member = await db.tripMember.findFirst({
    where: { tripId, userId: user.id },
  });
  if (!member) return NextResponse.json({ error: "not a member" }, { status: 403 });

  await db.tripMember.update({
    where: { id: member.id },
    data: { approvalStatus: parsed.data.decision },
  });

  // Did this take us to quorum?
  const members = await db.tripMember.findMany({ where: { tripId } });
  const approved = members.filter((m) => m.approvalStatus === "APPROVED").length;
  const declined = members.filter((m) => m.approvalStatus === "DECLINED").length;
  const total = members.length;
  const quorum = total <= 3 ? total : Math.ceil(total * (2 / 3));

  // Anyone declining halts the workflow.
  if (declined > 0) {
    await db.trip.update({ where: { id: tripId }, data: { status: "PLANNING" } });
    nudge(tripId);
    return NextResponse.json({ ok: true, approved, total, quorum, declined });
  }

  if (parsed.data.decision === "APPROVED" && approved >= quorum) {
    const it = await db.itinerary.findFirst({
      where: { id: parsed.data.itineraryId, tripId, status: "CURRENT" },
    });
    if (it) {
      await approveItinerary({
        tripId,
        itineraryId: it.id,
        userId: user.id,
      });
    }
  } else if (parsed.data.decision === "APPROVED") {
    await db.trip.update({
      where: { id: tripId },
      data: { status: "AWAITING_APPROVAL" },
    });
  }

  nudge(tripId);
  return NextResponse.json({ ok: true, approved, total, quorum });
}
