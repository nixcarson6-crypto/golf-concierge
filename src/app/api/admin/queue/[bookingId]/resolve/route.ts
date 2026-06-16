/**
 * Mark a concierge-queue booking as booked-by-hand → CONFIRMED.
 *
 * Admin-only. Sets the booking + its itinerary item to confirmed with the
 * operator-supplied confirmation code, stamps who/when in metadata, and nudges
 * the customer's workspace so the row flips to "Booked ✓".
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ bookingId: string }> },
) {
  const user = await requireUser();
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { bookingId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    confirmationCode?: string | null;
  };
  const code = body.confirmationCode?.trim() || null;

  const booking = await db.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const meta = (booking.metadata as Record<string, unknown> | null) ?? {};
  await db.booking.update({
    where: { id: bookingId },
    data: {
      status: "CONFIRMED",
      confirmationCode: code ?? booking.confirmationCode,
      confirmedAt: new Date(),
      provider: "MANUAL",
      metadata: {
        ...meta,
        concierge: {
          bookedByHand: true,
          by: user.email,
          at: new Date().toISOString(),
        },
      } as object,
    },
  });
  await db.itineraryItem.update({
    where: { id: booking.itineraryItemId },
    data: {
      confirmationState: "CONFIRMED",
      status: code ? `Booked · ${code}` : "Booked",
    },
  });

  await audit({
    tripId: booking.tripId,
    action: "BOOKING_CONFIRMED",
    title: "Concierge booked by hand",
    detail: `Operator ${user.email} confirmed${code ? ` (#${code})` : ""}.`,
    actorKind: "user",
    actorId: user.id,
    metadata: { bookingId, itemId: booking.itineraryItemId },
  });

  nudge(booking.tripId);
  return NextResponse.json({ ok: true });
}
