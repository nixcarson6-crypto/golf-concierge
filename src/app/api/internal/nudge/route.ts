/**
 * Internal nudge bridge.
 *
 * The browser agent runs inside Inngest (separate serverless invocation),
 * but our SSE event bus is in-process — so progress emitted from the agent
 * loop never reaches the customer's open `/api/trips/[id]/stream` connection
 * without help. This route is that help: the Inngest fn POSTs here after
 * each `updateProgress`, and we re-emit the event inside the web process so
 * the SSE listeners pick it up.
 *
 * Secret-guarded with `INTERNAL_NUDGE_SECRET` so it can't be spammed
 * externally. Falls back silently (no-op) if the secret isn't configured —
 * the customer's UI just refreshes a little less promptly while a booking
 * runs.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { emitTripEvent, nudge } from "@/lib/events";
import { optionalEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  tripId: z.string().min(1),
  /** Optional structured progress event. When present we emit it; otherwise
   *  we just fire a snapshot.changed nudge. */
  runId: z.string().optional(),
  progress: z.string().optional(),
});

export async function POST(req: Request) {
  const expected = optionalEnv("INTERNAL_NUDGE_SECRET");
  if (!expected) {
    // Nothing to verify against — accept but do not crash. Live progress
    // just won't stream until the secret is configured.
    return NextResponse.json({ ok: false, reason: "no-secret" }, { status: 200 });
  }
  const got = req.headers.get("x-internal-secret");
  if (got !== expected) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "bad-body" }, { status: 400 });
  }
  const { tripId, runId, progress } = parsed.data;
  if (runId && progress) {
    emitTripEvent({ kind: "agent.progress", tripId, runId, progress });
  }
  nudge(tripId);
  return NextResponse.json({ ok: true });
}
