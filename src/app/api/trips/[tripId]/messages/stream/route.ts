import { z } from "zod";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { streamReplyEvents } from "@/lib/ai/streamReply";
import { CONCIERGE_VOICE } from "@/lib/ai/prompts";
import { buildTripContext } from "@/lib/ai/trip-context";
import { processUserMessageBackground } from "@/lib/ai/conversation";
import { nudge } from "@/lib/events";
import { checkChatRate } from "@/lib/rate-limit";
import type { ChatCard } from "@/lib/ai/chat-cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

/**
 * Streaming version of the chat endpoint.
 *   1. Persist the user message immediately.
 *   2. Stream the concierge text reply token-by-token via SSE.
 *   3. Once streaming finishes, save the full assistant message and kick the
 *      structured constraint-extraction + downstream agents in the background.
 *
 * The client renders tokens as they arrive — chat feels instant.
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
    return new Response("forbidden", { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return new Response("not found", { status: 404 });

  if (!checkChatRate(user.id)) {
    return new Response("Too many messages — slow down a bit.", { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("invalid body", { status: 400 });
  const text = parsed.data.content;

  await db.chatMessage.create({
    data: { tripId, userId: user.id, role: "USER", content: text },
  });
  nudge(tripId);

  const rawHistory = (
    await db.chatMessage.findMany({
      where: { tripId },
      orderBy: { createdAt: "asc" },
      take: 30,
    })
  ).map((m) => ({
    role: (m.role === "ASSISTANT" ? "assistant" : "user") as "user" | "assistant",
    content: m.content,
  }));
  // Sanitize for Opus 4.7's strict alternation:
  //  1. Drop any leading assistant turns (must start with user).
  //  2. Drop any trailing assistant turns (must end with user — Opus 4.7
  //     rejects with "does not support assistant message prefill" otherwise).
  //  3. Merge consecutive same-role messages so user/assistant alternate.
  //  4. Drop empty-content messages — Anthropic rejects "" content blocks.
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const fromFirstUser =
    firstUserIdx === -1 ? [] : rawHistory.slice(firstUserIdx);
  let trimmed = fromFirstUser;
  while (
    trimmed.length > 0 &&
    trimmed[trimmed.length - 1].role === "assistant"
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of trimmed) {
    if (!m.content.trim()) continue;
    const last = history[history.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      history.push({ role: m.role, content: m.content });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      type OutboundEvent =
        | { type: "delta"; text: string }
        | { type: "tool_start"; id: string; tool: string; label: string }
        | { type: "tool_end"; id: string; tool: string; ok: boolean }
        | { type: "card"; card: ChatCard }
        | { type: "done"; full: string; cards: ChatCard[] }
        | { type: "error"; message: string };

      const send = (event: OutboundEvent) => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      };

      let full = "";
      const cards: ChatCard[] = [];
      try {
        // Build the live context (trip + user profile) but never let it
        // kill the stream. If the DB schema is stale or the query throws
        // for any reason we just continue without the context — the AI
        // can still reply, it just won't have profile auto-fill.
        let liveContext: string | undefined;
        try {
          liveContext = await buildTripContext({
            tripId,
            currentUserId: user.id,
          });
        } catch (err) {
          console.error("[trip-context] failed, continuing without it:", err);
        }
        const gen = streamReplyEvents({
          system: CONCIERGE_VOICE,
          liveContext,
          cacheSystem: true,
          history,
          maxTokens: 2000,
          tripId,
          userId: user.id,
        });
        // Hard cap on a single generator step so a wedged tool (e.g.
        // Duffel hanging, Anthropic deadlocked, Prisma stuck on a dead
        // connection) can't silently freeze the whole stream. 60 s gives
        // enough room for the 3-round "book → expire → re-search → present"
        // loop where a new Anthropic stream must start in round 3.
        const STEP_TIMEOUT_MS = 60_000;
        const stepWithTimeout = async () => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "concierge step timed out — partner API or DB stalled",
                  ),
                ),
              STEP_TIMEOUT_MS,
            );
          });
          try {
            return await Promise.race([gen.next(), timeout]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await stepWithTimeout();
          if (done) {
            full = (value as string) ?? full;
            break;
          }
          const ev = value;
          if (ev.type === "delta") {
            full += ev.text;
            send(ev);
          } else if (ev.type === "card") {
            cards.push(ev.card);
            send(ev);
          } else {
            send(ev);
          }
        }

        // Never save an empty assistant message — it leaves the user staring
        // at silence and confuses the AI on the next turn (it sees an
        // unanswered user message and loops). If the stream produced cards
        // but no prose, lead with a generic acknowledgement. If neither
        // text nor cards, explain the snag and ask the user to retry.
        let finalContent = full.trim();
        if (!finalContent) {
          finalContent =
            cards.length > 0
              ? "Here's what I pulled — pick one and I'll lock it in."
              : "I hit a snag mid-thought. Mind asking that again, or being a touch more specific?";
          console.warn(
            `[stream] empty reply saved with fallback (cards=${cards.length}, tripId=${tripId})`,
          );
        }

        await db.chatMessage.create({
          data: {
            tripId,
            role: "ASSISTANT",
            content: finalContent,
            metadata: {
              kind: "stream",
              cards: cards.length > 0 ? cards : undefined,
              fallback: finalContent !== full.trim() || undefined,
            },
          },
        });
        nudge(tripId);

        send({ type: "done", full: finalContent, cards });
      } catch (err) {
        // ALWAYS persist an assistant message on error, even when no text
        // was streamed. Without this the user's message has no reply in
        // DB — the chat shows silence on the next refetch and the AI
        // sees an unanswered user message on the next turn (which makes
        // it loop). Save the partial stream if we have one, otherwise a
        // visible explanation of the snag.
        const errMsg = err instanceof Error ? err.message : String(err);
        const fallbackContent = full.trim()
          ? full
          : `I hit a snag mid-thought (${errMsg.slice(0, 140)}). Try that again — usually it goes through on retry.`;
        try {
          await db.chatMessage.create({
            data: {
              tripId,
              role: "ASSISTANT",
              content: fallbackContent,
              metadata: {
                kind: "stream",
                cards: cards.length > 0 ? cards : undefined,
                interrupted: true,
                errorReason: errMsg.slice(0, 300),
              },
            },
          });
          nudge(tripId);
        } catch (writeErr) {
          console.error("[stream] fallback persist failed:", writeErr);
        }
        send({
          type: "error",
          message: errMsg,
        });
      } finally {
        controller.close();
        void processUserMessageBackground({
          trip,
          userId: user.id,
          text,
          assistantTextAlreadyEmitted: full,
        }).catch((err) => console.error("[background extraction]", err));
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
