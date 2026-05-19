import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await params;
  try {
    await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.trip.delete({ where: { id: tripId } });
  return NextResponse.json({ ok: true });
}
