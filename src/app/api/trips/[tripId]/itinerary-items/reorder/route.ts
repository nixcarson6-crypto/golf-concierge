import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itineraryId: z.string(),
  /** Ordered list of item IDs in their new sequence. */
  itemIds: z.array(z.string()).min(1).max(60),
});

/**
 * Persist a manual reorder. The schedule fixer runs after to flag any
 * conflicts the user introduced — quietly suggesting fixes via a notification.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  try {
    await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new NextResponse("invalid body", { status: 400 });
  const { itineraryId, itemIds } = parsed.data;

  // Verify all items belong to this itinerary.
  const items = await db.itineraryItem.findMany({
    where: { id: { in: itemIds }, itineraryId },
    select: { id: true },
  });
  if (items.length !== itemIds.length) {
    return NextResponse.json({ error: "items mismatch" }, { status: 400 });
  }

  await db.$transaction(
    itemIds.map((id, index) =>
      db.itineraryItem.update({
        where: { id },
        data: { orderIndex: index },
      }),
    ),
  );
  await audit({
    tripId,
    action: "TRIP_UPDATED",
    title: "Itinerary order updated",
    actorKind: "user",
  });
  nudge(tripId);

  // Background: run the schedule fixer in case the reorder produces conflicts.
  void import("@/lib/ai/agents/scheduleFixer")
    .then((m) => m.runScheduleFixer(tripId))
    .catch((err) => console.error("[schedule fixer after reorder]", err));

  return NextResponse.json({ ok: true });
}
