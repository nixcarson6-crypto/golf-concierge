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
import { optionalEnv } from "@/lib/env";
import {
  sendEmail,
  renderBookingConfirmationEmail,
  type ConfirmationLine,
} from "@/lib/email";
import { tripDisplayLabel } from "@/lib/trip-display";
import {
  bookFlightForCustomer,
  flightSelfBookLink,
} from "@/lib/bookings/flight-payment";
import { recordFlightBooking } from "@/lib/bookings/record-flight";
import {
  prepareAgentBooking,
  triggerAgentRun,
  hasInngestWorker,
  runAgentBatchSequentiallyInBackground,
} from "@/lib/bookings/dispatch-agent";
import { isAgentBookable } from "@/lib/bookings/agent-scope";
import type {
  FlightOfferSummary,
} from "@/lib/bookings/providers/duffel-search";

type Outcome = {
  category: "flight" | "hotel" | "golf" | "restaurant" | "transport";
  // "booking" = agent dispatched, running async (real status arrives via the
  // panel's live polling). "booked" = confirmed now (a real flight ticket, or
  // an item already CONFIRMED on a prior run). "self_book" = we deliberately
  // did NOT spend money — the customer books this one themselves (a direct
  // link is included).
  status:
    | "booked"
    | "booking"
    | "pencilled"
    | "skipped"
    | "failed"
    | "self_book"
    // The customer needs to add a card (Stripe Checkout) before we can charge
    // them and book — we never front the cost.
    | "needs_card";
  title: string;
  detail?: string;
  confirmationCode?: string;
  /** Direct booking link for self_book outcomes (e.g. flights). */
  link?: string;
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
        include: {
          items: { orderBy: { orderIndex: "asc" }, include: { booking: true } },
        },
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

  // Hotels' checkout always requires a billing/home address. If the trip has a
  // hotel and the profile has none, fail the WHOLE Book All up front with the
  // exact fix — far better than dispatching agent runs that all stall on the
  // empty address fields. (Per-item booking enforces the same thing.)
  const hasHotel = items.some((i) => i.type === "LODGING");
  if (hasHotel && !me.addressLine1) {
    return new Response(
      JSON.stringify({
        ok: false,
        needsProfile: true,
        error:
          "Add your home address in your profile (Street, City, State, Zip) — hotel checkouts require it. Then Book All completes every reservation.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

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
          // Money guardrail: bookFlightForCustomer NEVER spends our Duffel
          // balance unless the customer's card has been charged first. By
          // default it returns "self_book" — we hand the customer a direct
          // link and our balance is never touched. (See flight-payment.ts.)
          const outcome = await bookFlightForCustomer({
            userId: user.id,
            tripId,
            offerId: cheapest.id,
            passengers,
            ticketCents: cheapest.totalAmount,
          });
          if (outcome.mode === "needs_card") {
            outcomes.push({
              category: "flight",
              status: "needs_card",
              title: `${cheapest.airlineName} flight`,
              detail:
                "Add your card to book — we charge your card for the trip; your card pays for it, not ours.",
            });
          } else if (outcome.mode === "self_book") {
            const link = flightSelfBookLink({
              origin: suggested!.origin,
              destination: suggested!.destination,
              departDate: trip.startDate?.toISOString().slice(0, 10) ?? null,
              returnDate: trip.endDate?.toISOString().slice(0, 10) ?? null,
            });
            outcomes.push({
              category: "flight",
              status: "self_book",
              title: `${cheapest.airlineName} · $${Math.round(cheapest.totalAmount / 100).toLocaleString()}`,
              detail:
                "Book your flight directly — your card pays the airline, and Pyltrix handles the rest of your trip.",
              link,
            });
          } else if (outcome.mode === "failed") {
            outcomes.push({
              category: "flight",
              status: "failed",
              title: `${cheapest.airlineName} flight`,
              detail: outcome.error,
            });
          } else {
            const result = outcome.result;
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

  // ── Itinerary items (hotel, golf, car rental) → REAL browser agent ──
  // Book All now runs the SAME agent the per-item "Tap to book" uses on every
  // bookable item — it reaches each venue's real checkout, fills everything,
  // and books (or pauses for review with proof). No more fake "pencilled"
  // stubs. Dining/activities stay suggestions (the agent scope excludes them);
  // per-ride Uber/chauffeur transfers aren't browser-bookable (only car
  // rentals are — handled by isAgentBookable).
  const agentJobs: {
    tripId: string;
    bookingId: string;
    itineraryItemId: string;
    userId: string;
  }[] = [];
  for (const item of items) {
    if (!isAgentBookable(item.type, item.title, item.description)) continue;

    const category: Outcome["category"] =
      item.type === "LODGING"
        ? "hotel"
        : item.type === "TEE_TIME"
          ? "golf"
          : "transport";

    const prepared = await prepareAgentBooking({
      tripId,
      userId: user.id,
      item: {
        id: item.id,
        type: item.type,
        title: item.title,
        description: item.description,
        cost: item.cost,
        metadata: item.metadata,
        booking: item.booking
          ? { id: item.booking.id, status: item.booking.status }
          : null,
      },
    });

    if (!prepared.ok) {
      // walk-in / not bookable / already CONFIRMED → skip quietly.
      if (prepared.skip === "confirmed") {
        outcomes.push({
          category,
          status: "booked",
          title: item.title,
          detail: "Already booked.",
        });
      }
      continue;
    }

    outcomes.push({
      category,
      status: "booking",
      title: item.title,
      detail: prepared.idempotent
        ? "Already in progress."
        : "Pyltrix is booking this now.",
    });

    // Don't re-fire a run that's already in flight.
    if (!prepared.idempotent) {
      agentJobs.push({
        tripId,
        bookingId: prepared.bookingId,
        itineraryItemId: item.id,
        userId: user.id,
      });
    }
  }

  // Kick off the agent runs. Production: hand each to Inngest (fans out on its
  // own workers). Local dev: run them SEQUENTIALLY in the background — one
  // agent at a time so concurrent runs don't starve each other in one process.
  if (agentJobs.length > 0) {
    if (hasInngestWorker()) {
      for (const job of agentJobs) await triggerAgentRun(job);
    } else {
      runAgentBatchSequentiallyInBackground(agentJobs);
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

  // Confirmation email — the product's payoff: every booked/pencilled item
  // and its confirmation code in one place. Best-effort; a mail failure must
  // never fail the booking response. No-ops without RESEND_API_KEY.
  try {
    // Only email items that are ACTUALLY confirmed right now (a real flight,
    // or an item already booked on a prior run). Agent items dispatched this
    // request are still running — the agent's own flow emails/surfaces their
    // confirmation when each one lands, so we don't pre-announce them here.
    const confirmable = outcomes.filter((o) => o.status === "booked");
    if (confirmable.length > 0 && me.email) {
      const lines: ConfirmationLine[] = confirmable.map((o) => ({
        title: o.title,
        detail: o.detail,
        confirmationCode: o.confirmationCode,
        paymentMode: o.category === "flight" ? "pay_now" : "pay_at_property",
      }));
      const tripLabel = tripDisplayLabel({
        title: trip.title,
        destination: trip.destination,
      });
      const appUrl = optionalEnv("NEXT_PUBLIC_APP_URL") ?? "https://pyltrix.com";
      const mail = renderBookingConfirmationEmail({
        name: me.name ?? me.legalGivenName,
        tripLabel,
        lines,
        tripUrl: `${appUrl}/trips/${tripId}`,
      });
      await sendEmail({
        to: me.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    }
  } catch (err) {
    console.warn("[book-all] confirmation email failed:", err);
  }

  return new Response(
    JSON.stringify({ ok: true, outcomes }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
