/**
 * One-click flight booking endpoint. Takes a Duffel offer id + one
 * passenger payload (or several), books via Duffel, persists the
 * booking on the trip, and also saves the LEAD passenger's details
 * back to the User profile so the next booking can pre-fill them.
 *
 * Replaces the previous "send a chat message and let the AI book"
 * detour. No model call needed — straight Duffel + Postgres.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { bookFlightOffer } from "@/lib/bookings/providers/duffel-book";
import { recordFlightBooking } from "@/lib/bookings/record-flight";

const passengerSchema = z.object({
  given_name: z.string().min(1),
  family_name: z.string().min(1),
  born_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  gender: z.enum(["m", "f"]),
  email: z.string().email(),
  phone_number: z
    .string()
    .regex(/^\+\d{8,15}$/, "E.164 format, e.g. +12125550100"),
});

const bodySchema = z.object({
  offerId: z.string().min(1),
  passengers: z.array(passengerSchema).min(1).max(9),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    select: { id: true },
  });
  if (!trip) return new Response("not found", { status: 404 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.issues[0]?.message ?? "invalid body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { offerId, passengers } = parsed.data;

  const result = await bookFlightOffer({ offerId, passengers });
  if (!result.ok) {
    return new Response(
      JSON.stringify({ error: result.error }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    await recordFlightBooking({
      tripId,
      orderId: result.orderId,
      bookingReference: result.bookingReference,
      totalAmount: result.totalAmount,
      currency: result.currency,
      airline: result.airline,
      airlineCode: result.airlineCode ?? null,
      passengers: result.passengers,
      passengerNames: result.passengerNames,
      slicesSummary: result.slicesSummary,
      bookedSlices: result.bookedSlices,
      isSandbox: result.isSandbox,
    });
  } catch (err) {
    console.error("[book-flight] persist failed (but ticketed):", err);
  }

  // Save the lead passenger's details back to the user profile so the
  // NEXT booking pre-fills automatically. Best-effort — a profile
  // write failure shouldn't undo a successful ticket purchase.
  const lead = passengers[0];
  try {
    await db.user.update({
      where: { id: user.id },
      data: {
        legalGivenName: lead.given_name,
        legalFamilyName: lead.family_name,
        dateOfBirth: new Date(lead.born_on),
        gender: lead.gender,
        phone: lead.phone_number,
      },
    });
  } catch (err) {
    console.warn("[book-flight] profile save failed:", err);
  }

  nudge(tripId);

  return new Response(
    JSON.stringify({
      ok: true,
      bookingReference: result.bookingReference,
      airline: result.airline,
      totalUSD: Math.round(result.totalAmount / 100),
      currency: result.currency,
      isSandbox: result.isSandbox,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
