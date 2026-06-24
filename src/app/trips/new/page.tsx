import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Creating a new trip now jumps straight into the Hungry Root-style
 * quiz instead of the old chat workspace. We seed a DRAFT trip with
 * a placeholder title so the quiz has a tripId to write to, then
 * redirect to /trips/[id]/build where the questions start.
 */
export default async function NewTripPage() {
  const user = await requireUser();

  // Reuse an existing EMPTY draft (one whose quiz never built an itinerary)
  // instead of minting a fresh "Untitled trip" on every visit — otherwise the
  // trips list fills up with abandoned drafts. The quiz resumes from where it
  // left off (its state is keyed per-trip).
  const existingDraft = await db.trip.findFirst({
    where: { ownerId: user.id, status: "DRAFT", itineraries: { none: {} } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existingDraft) redirect(`/build/${existingDraft.id}`);

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
    },
  });
  redirect(`/build/${trip.id}`);
}
