import { requireTripAccess } from "@/lib/auth";
import { subscribeTrip, type TripEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min long-lived connection

/**
 * Server-Sent Events stream of trip activity. Sends a tiny `snapshot.changed`
 * heartbeat any time anything material happens on the trip. The client
 * refetches `/workspace` on each — keeps state authoritative on the server
 * without the cost of polling.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  try {
    await requireTripAccess(tripId);
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: TripEvent | { kind: "ready" } | { kind: "ping" }) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Stream may have been closed by the client.
        }
      };

      send({ kind: "ready" });
      heartbeat = setInterval(() => send({ kind: "ping" }), 25_000);
      unsubscribe = subscribeTrip(tripId, send);
    },
    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
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
