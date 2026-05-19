import { z } from "zod";
import { db } from "@/lib/db";
import { runStructured, withAgentRun } from "../orchestrator";
import { CONCIERGE_VOICE } from "../prompts";

const SYSTEM = `
${CONCIERGE_VOICE}

You extract structured preferences from a single trip member's recent
messages so the itinerary agent can personalise the plan to them. Be
conservative — only fill in fields you have actual signal for. Don't
guess. If they mention a handicap, capture it. If they mention dietary
preferences, dive deep. If they mention nightlife preferences, capture
them. Don't fabricate.
`.trim();

const schema = z.object({
  golfHandicap: z.number().int().min(-10).max(54).nullable().optional(),
  dietary: z.string().nullable().optional(),
  spirits: z.string().nullable().optional().describe("Preferred drinks/spirits — bourbon, mezcal, none"),
  nightlife: z.enum(["high", "moderate", "low", "none"]).nullable().optional(),
  earlyRiser: z.boolean().nullable().optional(),
  roomPreference: z.string().nullable().optional(),
  pace: z.enum(["relaxed", "balanced", "packed"]).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type MemberPreferenceData = z.infer<typeof schema>;

/**
 * Re-runs whenever a member adds a message. Cheap, fast model. Updates the
 * MemberPreference row idempotently. Empty / no-signal extractions are
 * skipped so we don't blow away real prefs with noise.
 */
export async function refreshMemberPreferences(args: {
  tripId: string;
  memberId: string;
}) {
  const { tripId, memberId } = args;
  const member = await db.tripMember.findUnique({
    where: { id: memberId },
    include: { user: true },
  });
  if (!member?.userId) return null;

  // Pull this member's recent messages plus any concierge messages directed
  // at them (member_welcome) for context.
  const messages = await db.chatMessage.findMany({
    where: { tripId },
    orderBy: { createdAt: "asc" },
    take: 60,
  });
  const mine = messages.filter((m) => m.userId === member.userId);
  if (mine.length === 0) return null;

  return withAgentRun({
    tripId,
    agentType: "CONSTRAINT_EXTRACTOR",
    input: { memberId },
    progress: `Personalising ${member.name ?? member.email}'s plan…`,
    fn: async () => {
      const transcript = mine
        .map((m) => `[${member.name ?? member.email}]: ${m.content}`)
        .join("\n");

      const result = await runStructured({
        tier: "fast",
        system: SYSTEM,
        cacheSystem: true,
        schema,
        toolName: "emit_member_preferences",
        toolDescription:
          "Emit structured preferences extracted from this member's messages.",
        messages: [
          {
            role: "user",
            content: `Member messages so far:\n${transcript}\n\nExtract structured preferences. Leave fields null when you don't have explicit signal.`,
          },
        ],
        maxTokens: 600,
        temperature: 0.2,
      });

      const hasSignal = Object.values(result).some(
        (v) => v !== null && v !== undefined,
      );
      if (!hasSignal) return { skipped: true };

      await db.memberPreference.upsert({
        where: { memberId },
        create: {
          memberId,
          data: result as object,
          rawAnswers: transcript.slice(0, 4000),
        },
        update: {
          data: result as object,
          rawAnswers: transcript.slice(0, 4000),
        },
      });
      return { updated: true, fields: Object.keys(result).filter((k) => (result as Record<string, unknown>)[k] != null) };
    },
  });
}
