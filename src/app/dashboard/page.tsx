import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Post-login entry routing:
 *  - If the user has a fully-built trip (status past DRAFT), open the
 *    most recent one in the workspace.
 *  - If they only have a half-finished DRAFT, resume the quiz where
 *    they left off (still no itinerary, so /build is the right place).
 *  - First-timers: go to /trips/new which creates a fresh DRAFT and
 *    bounces into the quiz — no more chat-seeded empty trips.
 */
export default async function DashboardPage() {
  const user = await requireUser();

  const built = await db.trip.findFirst({
    where: {
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      status: { not: "DRAFT" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (built) redirect(`/trips/${built.id}`);

  const draft = await db.trip.findFirst({
    where: { ownerId: user.id, status: "DRAFT" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (draft) redirect(`/build/${draft.id}`);

  redirect("/trips/new");
}
