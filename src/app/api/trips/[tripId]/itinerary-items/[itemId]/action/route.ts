import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTripAccess } from "@/lib/auth";
import { runItemAction, setItemLock } from "@/lib/ai/agents/itemAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("swap"),
    instruction: z.string().trim().min(1).max(500).nullable().optional(),
  }),
  z.object({ action: z.literal("upgrade") }),
  z.object({ action: z.literal("downgrade") }),
  z.object({ action: z.literal("regenerate") }),
  z.object({ action: z.literal("lock"), locked: z.boolean() }),
]);

export async function POST(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ tripId: string; itemId: string }>;
  },
) {
  const { tripId, itemId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (parsed.data.action === "lock") {
    await setItemLock(tripId, { itemId, locked: parsed.data.locked });
    return NextResponse.json({ ok: true });
  }

  try {
    const result = await runItemAction({
      tripId,
      itemId,
      action: parsed.data.action,
      instruction: "instruction" in parsed.data ? parsed.data.instruction : null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[item action]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    );
  }
}
