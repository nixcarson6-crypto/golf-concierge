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
  // Anthropic requires the first message to be role "user". The trip is seeded
  // with an assistant welcome message, so drop any leading assistant turns.
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const history = firstUserIdx === -1 ? [] : rawHistory.slice(firstUserIdx);

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
          maxTokens: 1200,
          tripId,
          userId: user.id,
        });
        // Hard cap on a single generator step so a wedged tool (e.g.
        // Duffel hanging, Anthropic deadlocked, Prisma stuck on a dead
        // connection) can't silently freeze the whole stream. The
        // client-side silence watchdog gives us a second line of
        // defence at 30s; this server-side cap fires earlier so we
        // get to send a clean error event before the connection dies.
        const STEP_TIMEOUT_MS = 25_000;
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

        await db.chatMessage.create({
          data: {
            tripId,
            role: "ASSISTANT",
            content: full,
            metadata: {
              kind: "stream",
              cards: cards.length > 0 ? cards : undefined,
            },
          },
        });
        nudge(tripId);

        send({ type: "done", full, cards });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "stream failed",
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
