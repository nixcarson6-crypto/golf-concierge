import { db } from "@/lib/db";
import type { ItineraryItem } from "@prisma/client";
import { partnerFor } from "./registry";
import { runFallbackForItem } from "@/lib/ai/agents/fallback";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";
import { runWithRetry } from "./queue";

/**
 * Approval-time booking executor v2.
 *
 * For each itinerary item without a confirmed booking:
 *   1. Persist a SEARCHING Booking + flip the item state.
 *   2. If the partner supports two-phase hold+confirm, hold first, then
 *      confirm. Otherwise call book() directly.
 *   3. Wrap every partner call in runWithRetry — exponential backoff on
 *      transient errors only.
 *   4. On persistent failure → fallback agent picks up the slack.
 *
 * Items book in parallel; one failure does not block siblings.
 */
export async function executeItineraryBookings(itineraryId: string) {
  const itinerary = await db.itinerary.findUnique({
    where: { id: itineraryId },
    include: { items: { include: { booking: true } } },
  });
  if (!itinerary) throw new Error(`Itinerary ${itineraryId} not found`);

  const pending = itinerary.items.filter(
    (i) => !i.booking || i.booking.status === "FAILED",
  );

  await Promise.all(pending.map((item) => bookOne(itinerary.tripId, item)));

  return db.itinerary.findUnique({
    where: { id: itineraryId },
    include: { items: { include: { booking: true } } },
  });
}

async function bookOne(
  tripId: string,
  item: ItineraryItem & { booking: { id: string; status: string } | null },
) {
  const partner = partnerFor(item.type);

  const existing = item.booking
    ? await db.booking.findUnique({ where: { id: item.booking.id } })
    : null;
  const booking =
    existing ??
    (await db.booking.create({
      data: {
        tripId,
        itineraryItemId: item.id,
        provider: partner.provider,
        type: item.type,
        status: "SEARCHING",
        cost: item.cost,
      },
    }));

  await db.itineraryItem.update({
    where: { id: item.id },
    data: { confirmationState: "SEARCHING", status: "Searching availability…" },
  });
  await audit({
    tripId,
    action: "BOOKING_REQUESTED",
    title: `Searching ${item.title}`,
    actorKind: "agent",
    actorId: partner.provider,
    metadata: { itemId: item.id },
  });

  try {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const request = {
      tripId,
      itineraryItemId: item.id,
      type: item.type,
      title: item.title,
      startTime: item.startTime,
      endTime: item.endTime,
      party: typeof meta.partySize === "number" ? meta.partySize : null,
      budget: item.cost,
      location: item.location,
      metadata: meta,
    };

    let result;
    if (partner.supportsHold && partner.hold && partner.confirm) {
      // Two-phase: hold inventory first, then confirm.
      await db.itineraryItem.update({
        where: { id: item.id },
        data: { confirmationState: "HOLDING", status: "Holding…" },
      });
      const quote = await runWithRetry(() => partner.quote(request), {
        onAttempt: (n, err) =>
          n > 1 && console.warn(`[booking quote retry ${n}]`, err),
      });
      const held = await runWithRetry(() => partner.hold!(request, quote));
      await db.booking.update({
        where: { id: booking.id },
        data: {
          provider: held.provider,
          providerReference: held.providerReference,
          cost: held.cost,
          status: "HELD",
          heldUntil: held.heldUntil,
          metadata: held.raw as object | undefined,
          attempts: { increment: 1 },
        },
      });
      await audit({
        tripId,
        action: "BOOKING_HELD",
        title: `Held ${item.title}`,
        detail: held.heldUntil
          ? `Hold expires ${held.heldUntil.toLocaleString()}`
          : undefined,
        actorKind: "agent",
        actorId: partner.provider,
      });
      result = await runWithRetry(() =>
        partner.confirm!(held.providerReference),
      );
    } else {
      // One-shot.
      result = await runWithRetry(() => partner.book(request), {
        onAttempt: (n, err) =>
          n > 1 && console.warn(`[booking book retry ${n}]`, err),
      });
    }

    await db.booking.update({
      where: { id: booking.id },
      data: {
        provider: result.provider,
        providerReference: result.providerReference,
        confirmationCode: result.confirmationCode,
        cost: result.cost,
        status: result.status,
        heldUntil: result.heldUntil,
        confirmedAt: result.status === "CONFIRMED" ? new Date() : null,
        metadata: result.raw as object | undefined,
        attempts: { increment: 1 },
      },
    });

    await db.itineraryItem.update({
      where: { id: item.id },
      data: {
        confirmationState: result.status === "CONFIRMED" ? "CONFIRMED" : "HOLDING",
        status: result.status === "CONFIRMED" ? "Confirmed" : "Holding…",
      },
    });
    await audit({
      tripId,
      action: "BOOKING_CONFIRMED",
      title: `Confirmed ${item.title}`,
      detail: result.confirmationCode
        ? `Confirmation: ${result.confirmationCode}`
        : undefined,
      actorKind: "agent",
      actorId: partner.provider,
    });
    nudge(tripId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.booking.update({
      where: { id: booking.id },
      data: {
        status: "FAILED",
        lastError: msg,
        attempts: { increment: 1 },
      },
    });
    await db.itineraryItem.update({
      where: { id: item.id },
      data: { confirmationState: "FAILED", status: "Re-optimizing…" },
    });
    await audit({
      tripId,
      action: "BOOKING_FAILED",
      title: `Booking failed: ${item.title}`,
      detail: msg.slice(0, 240),
      actorKind: "agent",
      actorId: partner.provider,
    });
    nudge(tripId);
    void runFallbackForItem({
      tripId,
      itineraryItemId: item.id,
      reason: msg.slice(0, 200),
    }).catch((err) => console.error("[fallback agent]", err));
  }
}

/**
 * Suggested deposit for a trip given its bookings. Sum 25% of confirmed
 * costs as a default; partner-specific overrides can adjust later. Bounded
 * 100..30000 USD per group to avoid silly numbers in edge cases.
 */
export function suggestedDepositCents(args: {
  itineraryTotalCents: number;
}): number {
  const dep = Math.round(args.itineraryTotalCents * 0.25);
  return Math.max(10000, Math.min(3_000_000, dep));
}
