import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove a booking from the trip workspace. We don't hard-delete (the
 * audit trail matters for refund/dispute conversations) — we mark the
 * booking CANCELLED and its itinerary item Superseded, which is exactly
 * how auto-supersede works when the AI books a replacement.
 *
 * Note: this does NOT call the provider's cancel API. For sandbox bookings
 * there's nothing to cancel; for live bookings the caller still needs to
 * contact the airline/hotel/etc. for any refund. The button is a workspace
 * cleanup, not a money-back action — surface that honestly in the UI.
 */
export async function DELETE(
  _req: Request,
  {
    params,
  }: { params: Promise<{ tripId: string; bookingId: string }> },
) {
  const { tripId, bookingId } = await params;
  try {
    await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const booking = await db.booking.findFirst({
    where: { id: bookingId, tripId },
    select: { id: true, type: true, itineraryItemId: true, confirmationCode: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await db.booking.update({
    where: { id: booking.id },
    data: { status: "CANCELLED" },
  });
  if (booking.itineraryItemId) {
    const item = await db.itineraryItem.findUnique({
      where: { id: booking.itineraryItemId },
      select: { metadata: true },
    });
    await db.itineraryItem.update({
      where: { id: booking.itineraryItemId },
      data: {
        confirmationState: "CANCELLED",
        status: "Removed",
        metadata: {
          ...((item?.metadata as Record<string, unknown> | null) ?? {}),
          removedAt: new Date().toISOString(),
          removedBy: "user",
        },
      },
    });
  }

  await audit({
    tripId,
    action: "ITEM_SWAPPED",
    title: `Removed ${booking.type.toLowerCase()} booking from workspace`,
    detail: booking.confirmationCode
      ? `Confirmation: ${booking.confirmationCode}`
      : undefined,
    actorKind: "user",
    actorId: "workspace",
  });

  nudge(tripId);
  return NextResponse.json({ ok: true });
}
