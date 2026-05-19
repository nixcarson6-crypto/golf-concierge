import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Post-login entry: drop the user straight into a chat.
 * - If they have any trips, jump to the most recent.
 * - If they don't, spin up a blank "Untitled trip" so first-timers also
 *   land in the concierge instead of an empty list.
 */
export default async function DashboardPage() {
  const user = await requireUser();

  const latest = await db.trip.findFirst({
    where: {
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  if (latest) redirect(`/trips/${latest.id}`);

  const trip = await db.trip.create({
    data: {
      ownerId: user.id,
      title: "Untitled trip",
      status: "DRAFT",
      members: {
        create: {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: "OWNER",
          joinedAt: new Date(),
          approvalStatus: "APPROVED",
        },
      },
      chatMessages: {
        create: {
          userId: user.id,
          role: "ASSISTANT",
          content:
            "Welcome — tell me about the trip. Where you're thinking, when, how many guys, the vibe, and any non-negotiables. I'll take it from there.",
        },
      },
    },
    select: { id: true },
  });

  redirect(`/trips/${trip.id}`);
}
