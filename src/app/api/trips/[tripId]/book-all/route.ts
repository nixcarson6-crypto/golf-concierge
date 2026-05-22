/**
 * "Book all" — the master commit step. Iterates through every
 * actionable item on the trip (flights, hotels, golf, restaurants,
 * ground transport) and books each via its provider integration.
 * Real providers (Duffel) issue real tickets; stub providers
 * (Hotelbeds pending, Lightspeed pending, etc.) record a STUB-
 * booking so the workspace reflects intent even before partner APIs
 * are live.
 *
 * Returns a per-category summary so the client can show "Flight
 * ✅ booked, Hotel ⏳ pencilled, Tee time ⏳ pencilled, …" instead of
 * a single opaque success/failure.
 *
 * Required: user must have a complete saved traveler profile (legal
 * names, DOB, gender, phone) before any real flight can ticket. If
 * profile is incomplete we return a 400 with `needsProfile: true`
 * so the client can prompt the user to fill it in.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { bookFlightOffer } from "@/lib/bookings/providers/duffel-book";
import { recordFlightBooking } from "@/lib/bookings/record-flight";
import type {
  FlightOfferSummary,
} from "@/lib/bookings/providers/duffel-search";

type Outcome = {
  category: "flight" | "hotel" | "golf" | "restaurant" | "transport";
  status: "booked" | "pencilled" | "skipped" | "failed";
  title: string;
  detail?: string;
  confirmationCode?: string;
};

type SuggestedFlightsBlock = {
  origin: string;
  destination: string;
  cabin: string;
  passengers: number;
  offers: FlightOfferSummary[];
};

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    include: {
      itineraries: {
        where: { status: { in: ["DRAFT", "CURRENT"] } },
        orderBy: { version: "desc" },
        take: 1,
        include: { items: { orderBy: { orderIndex: "asc" } } },
      },
      bookings: true,
    },
  });
  if (!trip) return new Response("not found", { status: 404 });

  // Profile completeness check — flight booking requires every field.
  const me = await db.user.findUnique({ where: { id: user.id } });
  if (
    !me ||
    !me.legalGivenName ||
    !me.legalFamilyName ||
    !me.dateOfBirth ||
    !me.gender ||
    !me.phone
  ) {
    return new Response(
      JSON.stringify({
        ok: false,
        needsProfile: true,
        error:
          "Your traveler profile is incomplete. Fill it in once, then Book All works on every trip after.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const outcomes: Outcome[] = [];
  const itinerary = trip.itineraries[0] ?? null;
  const items = itinerary?.items ?? [];

  // ── Flight ─────────────────────────────────────────────────────────
  const alreadyBookedFlight = trip.bookings.find(
    (b) => b.type === "FLIGHT" && b.status === "CONFIRMED",
  );
  if (alreadyBookedFlight) {
    outcomes.push({
      category: "flight",
      status: "booked",
      title: alreadyBookedFlight.confirmationCode
        ? `Flight ${alreadyBookedFlight.confirmationCode}`
        : "Flight",
      detail: "Already booked.",
      confirmationCode: alreadyBookedFlight.confirmationCode ?? undefined,
    });
  } else {
    const suggested = (trip.constraints as Record<string, unknown> | null)
      ?.suggestedFlights as SuggestedFlightsBlock | undefined;
    const cheapest = suggested?.offers?.[0];
    if (!cheapest) {
      outcomes.push({
        category: "flight",
        status: "skipped",
        title: "Flight",
        detail: "No live flight options found for this trip.",
      });
    } else {
      // Build the passenger payload from the saved profile. For groups
      // > 1 we only have the lead's details — additional passengers
      // need the Done modal next session, so for now we book what we
      // can and surface the gap.
      const dob = me.dateOfBirth.toISOString().slice(0, 10);
      const passengers = [
        {
          given_name: me.legalGivenName!,
          family_name: me.legalFamilyName!,
          born_on: dob,
          gender: (me.gender === "f" ? "f" : "m") as "m" | "f",
          email: me.email,
          phone_number: me.phone!,
        },
      ];
      const need = suggested?.passengers ?? 1;
      if (need > 1) {
        outcomes.push({
          category: "flight",
          status: "skipped",
          title: `Flight (${need} travelers)`,
          detail: `Need details for ${need - 1} additional traveler(s). Add them via the booking form on each card, then re-run Book All.`,
        });
      } else {
        try {
          const result = await bookFlightOffer({
            offerId: cheapest.id,
            passengers,
          });
          if (!result.ok) {
            outcomes.push({
              category: "flight",
              status: "failed",
              title: `${cheapest.airlineName} flight`,
              detail: result.error,
            });
          } else {
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
              console.warn("[book-all] flight persist failed:", err);
            }
            outcomes.push({
              category: "flight",
              status: "booked",
              title: `${result.airline} flight`,
              detail: `$${Math.round(result.totalAmount / 100).toLocaleString()} total`,
              confirmationCode: result.bookingReference,
            });
          }
        } catch (err) {
          outcomes.push({
            category: "flight",
            status: "failed",
            title: "Flight",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ── Itinerary items (hotel, golf, restaurant, transport) ──────────
  // For each pencilled-in item, we record a STUB booking so the
  // workspace shows "Pencilled" status. When partner APIs (Hotelbeds,
  // Lightspeed Golf, OpenTable, CarTrawler) flip live, this same code
  // path issues real reservations without changing the UX.
  for (const item of items) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    if (meta.bookedAt) continue; // already locked in earlier

    // Map the Prisma ItineraryItemType enum onto our public Outcome
    // category for the client. The Booking row keeps the original
    // enum value as `type`.
    const category: Outcome["category"] | null =
      item.type === "LODGING"
        ? "hotel"
        : item.type === "TEE_TIME"
          ? "golf"
          : item.type === "DINING"
            ? "restaurant"
            : item.type === "TRANSPORT"
              ? "transport"
              : null;
    if (!category) continue;

    try {
      // Mark the itinerary item as "pencilled" and create a STUB
      // booking so it surfaces under the Booked list with the right
      // status. Real partner integration replaces this with a true
      // confirmation when those keys land.
      // Reservations vs payments: most golf resorts, courses, and
      // every restaurant secure a booking with name/contact only and
      // charge at check-in / when you dine. Mark these so the Pay
      // CTA doesn't try to charge for them.
      //   pay_at_property → customer pays at the venue
      //   pay_now         → Pyltrix charges via Stripe (flights, some
      //                     transport)
      const paymentMode: "pay_at_property" | "pay_now" =
        category === "transport" ? "pay_now" : "pay_at_property";
      const stubRef = `STUB-${category.toUpperCase()}-${item.id.slice(-8)}`;
      await db.booking.create({
        data: {
          tripId,
          itineraryItemId: item.id,
          provider:
            category === "golf"
              ? "GOLFNOW"
              : category === "restaurant"
                ? "OPENTABLE"
                : "INTERNAL",
          providerReference: stubRef,
          type: item.type,
          status: "CONFIRMED",
          confirmationCode: stubRef,
          cost: item.cost,
          confirmedAt: new Date(),
          metadata: {
            isStub: true,
            paymentMode,
            stubReason: `Awaiting ${category} partner API access`,
            itemTitle: item.title,
            itemLocation: item.location,
          },
        },
      });
      await db.itineraryItem.update({
        where: { id: item.id },
        data: {
          confirmationState: "CONFIRMED",
          status: "Pencilled",
          metadata: {
            ...meta,
            bookedAt: new Date().toISOString(),
            stubRef,
          },
        },
      });
      outcomes.push({
        category,
        status: "pencilled",
        title: item.title,
        detail:
          "Recorded — awaiting partner API to issue real confirmation.",
        confirmationCode: stubRef,
      });
    } catch (err) {
      outcomes.push({
        category,
        status: "failed",
        title: item.title,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  nudge(tripId);

  // Mark the trip as booked once we have at least one real flight ticket.
  if (
    outcomes.some(
      (o) => o.category === "flight" && o.status === "booked",
    )
  ) {
    try {
      await db.trip.update({
        where: { id: tripId },
        data: { status: "BOOKED" },
      });
    } catch (err) {
      console.warn("[book-all] trip status update failed:", err);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, outcomes }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
