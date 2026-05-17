import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { processUserMessage } from "@/lib/ai/conversation";
import { checkChatRate } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

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
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!checkChatRate(user.id)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many messages — slow down a bit." },
      { status: 429 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result = await processUserMessage({
      trip,
      userId: user.id,
      text: parsed.data.content,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[chat]", err);
    // Surface as an assistant chat message so the UI doesn't go silent.
    await db.chatMessage.create({
      data: {
        tripId: trip.id,
        role: "ASSISTANT",
        content:
          "Sorry — I lost my line of thought there. Could you say that again?",
        metadata: {
          error: err instanceof Error ? err.message : String(err),
          kind: "error",
        },
      },
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const messages = await db.chatMessage.findMany({
    where: { tripId },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return NextResponse.json({ messages });
}
