import { db } from "@/lib/db";
import { runText, withAgentRun } from "../orchestrator";
import { CONCIERGE_VOICE } from "../prompts";

/**
 * Rolling conversation summary.
 *
 * When the chat history exceeds CONTEXT_TURNS, we summarise everything older
 * than the trailing window into a compact one-paragraph context block. The
 * itinerary + constraint agents pull this in so the AI never "forgets"
 * decisions or preferences made many turns ago, without paying for the
 * tokens to re-process them every turn.
 *
 * Idempotent: runs cheaply when the message count hasn't moved meaningfully.
 */

const TRAILING_WINDOW = 12;
const SUMMARISE_AFTER = 18;

export async function maybeUpdateConversationSummary(tripId: string) {
  const messageCount = await db.chatMessage.count({ where: { tripId } });
  if (messageCount < SUMMARISE_AFTER) return null;

  const existing = await db.conversationSummary.findUnique({
    where: { tripId },
  });
  // Only re-summarise if at least 6 new messages have accumulated since the
  // last summary; otherwise we'd be paying for nothing.
  if (existing && messageCount - existing.messageCount < 6) return null;

  const allMessages = await db.chatMessage.findMany({
    where: { tripId },
    orderBy: { createdAt: "asc" },
  });
  const cutoff = allMessages.length - TRAILING_WINDOW;
  if (cutoff <= 0) return null;
  const older = allMessages.slice(0, cutoff);
  if (older.length === 0) return null;

  return withAgentRun({
    tripId,
    agentType: "CONSTRAINT_EXTRACTOR",
    input: { older: older.length },
    progress: "Compacting conversation memory…",
    fn: async () => {
      const transcript = older
        .map((m) => {
          const role =
            m.role === "ASSISTANT"
              ? "Concierge"
              : m.role === "USER"
                ? "Member"
                : m.role;
          return `${role}: ${m.content}`;
        })
        .join("\n");

      const summary = await runText({
        tier: "fast",
        system: `${CONCIERGE_VOICE}\n\nYou compact a long conversation into a concise factual note for future agents — bullet-style, focusing on decisions made, preferences expressed, constraints set, and unresolved questions. Skip pleasantries. Don't speculate. ≤ 180 words.`,
        messages: [
          {
            role: "user",
            content: `Earlier conversation transcript to compact:\n\n${transcript}`,
          },
        ],
        maxTokens: 600,
        temperature: 0.3,
      });

      const upToTime = older[older.length - 1].createdAt;
      await db.conversationSummary.upsert({
        where: { tripId },
        create: {
          tripId,
          content: summary,
          upToTime,
          messageCount,
        },
        update: {
          content: summary,
          upToTime,
          messageCount,
        },
      });
      return { length: summary.length, messageCount };
    },
  });
}
