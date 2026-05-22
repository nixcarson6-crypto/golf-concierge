/**
 * Update the signed-in user's saved traveler profile without making a
 * booking. Lets customers fill out their info ahead of time so the
 * eventual one-click booking has everything pre-filled — and crucially
 * lets people back out of the auto-book modal that opens after the
 * quiz without losing the data they just typed.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";

const bodySchema = z.object({
  legalGivenName: z.string().min(1).max(80).optional(),
  legalFamilyName: z.string().min(1).max(80).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(["m", "f"]).optional(),
  phone: z.string().regex(/^\+\d{8,15}$/).optional(),
});

export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { dateOfBirth, ...rest } = parsed.data;
  await db.user.update({
    where: { id: user.id },
    data: {
      ...rest,
      ...(dateOfBirth ? { dateOfBirth: new Date(dateOfBirth) } : {}),
    },
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
