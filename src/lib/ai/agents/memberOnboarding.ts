import { z } from "zod";
import { db } from "@/lib/db";
import { runStructured, withAgentRun } from "../orchestrator";
import { CONCIERGE_VOICE } from "../prompts";
import { nudge } from "@/lib/events";

const SYSTEM = `
${CONCIERGE_VOICE}

A new member just joined a planned trip. Write ONE warm, short concierge
welcome (≤ 2 sentences). Then ask up to 2 crisp questions that will help
personalise the plan: dietary preferences, golf handicap, favourite nightlife
vibe, room arrangement, anything you don't already know about them.

Don't repeat questions whose answers are already in the trip preferences.
`.trim();

const responseSchema = z.object({
  greeting: z.string(),
  questions: z.array(z.string()).min(0).max(2),
});

export async function welcomeMember(args: {
  tripId: string;
  memberId: string;
  memberName: string | null;
  memberEmail: string;
}) {
  const trip = await db.trip.findUnique({
    where: { id: args.tripId },
    include: { preferences: true },
  });
  if (!trip) return;

  return withAgentRun({
    tripId: trip.id,
    agentType: "CONSTRAINT_EXTRACTOR",
    input: { memberId: args.memberId },
    progress: "Welcoming new member…",
    fn: async () => {
      const result = await runStructured({
        tier: "fast",
        system: SYSTEM,
        schema: responseSchema,
        toolName: "emit_welcome",
        toolDescription: "Emit a concierge welcome + up to 2 questions",
        messages: [
          {
            role: "user",
            content: [
              `Trip: ${trip.title} → ${trip.destination ?? "TBD"} for ${trip.groupSize ?? "?"} players.`,
              `New member: ${args.memberName ?? args.memberEmail}`,
              `Existing preferences captured: ${trip.preferences.length}`,
            ].join("\n"),
          },
        ],
        maxTokens: 400,
        temperature: 0.6,
      });

      const content = result.questions.length
        ? `${result.greeting}\n\n${result.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
        : result.greeting;

      await db.chatMessage.create({
        data: {
          tripId: trip.id,
          role: "ASSISTANT",
          content,
          metadata: {
            kind: "member_welcome",
            memberId: args.memberId,
            questions: result.questions,
          },
        },
      });
      nudge(trip.id);
      return result;
    },
  });
}
