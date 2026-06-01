import { redirect } from "next/navigation";
import { db, withDbRetry } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { QuizContainer } from "@/components/quiz/quiz-container";

export const dynamic = "force-dynamic";

/**
 * The Hungry Root-style intake. Replaces the chat-based onboarding —
 * users answer a structured quiz, the server generates the plan with
 * a single AI pass, then they land back on the trip page to see it.
 *
 * Resilience note: this page's only server work is a cheap ownership
 * check. On a slow/contended connection (e.g. while a build is holding
 * the Neon pool) that query can transiently fail — which previously
 * surfaced as a hard 500 on /build/[id] and bounced the user. We now
 * retry, and on a PERSISTENT DB error we still render the quiz rather
 * than 500: the build + workspace APIs re-check ownership anyway, and
 * QuizContainer rehydrates the user's answers from localStorage, so a
 * momentary DB blip can't wipe their progress or hard-fail the page.
 */
export default async function BuildTripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const user = await requireUser();

  let lookupFailed = false;
  let trip: { id: string } | null = null;
  try {
    trip = await withDbRetry(
      () =>
        db.trip.findFirst({
          where: { id: tripId, ownerId: user.id },
          select: { id: true, status: true },
        }),
      "build.tripLookup",
    );
  } catch {
    // DB couldn't be reached (pool starved during a concurrent build, or a
    // Neon connection drop). Don't 500 — fall through and render the quiz.
    lookupFailed = true;
  }

  // Only redirect when we DEFINITIVELY know the trip isn't theirs (query
  // succeeded and returned nothing). A failed lookup is NOT "not found".
  if (!lookupFailed && !trip) redirect("/dashboard");

  return <QuizContainer tripId={tripId} />;
}
