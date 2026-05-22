import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { QuizContainer } from "@/components/quiz/quiz-container";

export const dynamic = "force-dynamic";

/**
 * The Hungry Root-style intake. Replaces the chat-based onboarding —
 * users answer a structured quiz, the server generates the plan with
 * a single AI pass, then they land back on the trip page to see it.
 */
export default async function BuildTripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const user = await requireUser();
  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    select: { id: true, status: true },
  });
  if (!trip) redirect("/dashboard");

  return <QuizContainer tripId={tripId} />;
}
