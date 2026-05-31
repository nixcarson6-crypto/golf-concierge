/**
 * Shared types + pure normalisers for the browser-agent "brain".
 *
 * This file has ZERO external/runtime dependencies on Browserbase, Stripe,
 * or the Anthropic SDK — it's pure data shaping, so it's fully unit-testable
 * and safe to build/ship before those accounts exist. `goal.ts` and
 * `outcome.ts` build on these types; `runtime.ts`/`agent.ts` (the account-
 * gated parts) consume them later.
 */

import type { BookingRequest } from "../types";

/**
 * The lead traveller's reservation identity. Sourced from the saved User /
 * TripMember profile (legalGivenName, legalFamilyName, email, phone,
 * dateOfBirth). We only ever pass the agent data the customer actually gave
 * us — the agent is forbidden from fabricating missing fields.
 */
export type TravelerIdentity = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string; // E.164 preferred (e.g. +12125550100)
  /** YYYY-MM-DD. Only some venues ask for it; null when we don't have it. */
  dateOfBirth?: string | null;
  /** Number of people on the reservation. */
  partySize: number;
};

/**
 * The booking target, resolved from Google Places (`/api/places/contact`).
 * `startUrl` is the venue's website; the agent navigates from there to the
 * actual booking page itself. `phone` is the human fallback we surface if
 * the agent can't complete the booking.
 */
export type VenueTarget = {
  name: string;
  startUrl: string;
  phone?: string | null;
  address?: string | null;
};

/**
 * A fully-normalised, agent-ready booking task. Everything the goal builder
 * and the runtime need, with dates/times/budget already shaped into the
 * forms the prompt expects. Produced by `buildBookingTask`.
 */
export type BookingTask = {
  request: BookingRequest;
  traveler: TravelerIdentity;
  venue: VenueTarget;
  /** YYYY-MM-DD of the reservation, or null if the item had no date. */
  isoDate: string | null;
  /** Human reservation time ("7:40 PM"), venue-local intent, or null. */
  displayTime: string | null;
  /** Long human date ("Friday, August 21, 2026") for the prompt, or null. */
  displayDate: string | null;
  /** Hard budget ceiling in cents (from the priced item), or null if unknown. */
  budgetCents: number | null;
  /** Same ceiling in whole USD for the prompt, or null. */
  budgetUsd: number | null;
};

/* -------------------------------------------------------------------------- */
/* Pure normalisers (no side effects, no deps — unit-testable)                 */
/* -------------------------------------------------------------------------- */

/**
 * Format a Date to YYYY-MM-DD using UTC components.
 *
 * Itinerary item times are persisted from the AI's naive ISO strings
 * (`new Date("2026-08-21T19:40:00")` → stored as that instant). Reading them
 * back with UTC getters round-trips to the date/time the AI intended, which
 * is the venue-local reservation time. We deliberately use UTC getters (not
 * the server's local TZ, which is UTC on Vercel anyway) so the value is
 * stable regardless of where the code runs.
 */
export function toIsoDate(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Human "Friday, August 21, 2026" (UTC components — see toIsoDate). */
export function toDisplayDate(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Human "7:40 PM" (UTC components — see toIsoDate). Null if midnight-only. */
export function toDisplayTime(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  // A bare date (no time component) round-trips to 00:00 UTC — treat that as
  // "no specific time" rather than telling the agent to book for midnight.
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return null;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Cents → whole USD (rounded), or null. */
export function centsToUsd(cents: number | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return Math.round(cents / 100);
}

/**
 * Assemble a normalised BookingTask from the raw request + traveller +
 * venue. Pure: no IO. The party size prefers the request's `party`, then
 * the traveller's `partySize`, defaulting to 1 (never 0/NaN).
 */
export function buildBookingTask(args: {
  request: BookingRequest;
  traveler: TravelerIdentity;
  venue: VenueTarget;
}): BookingTask {
  const { request, traveler, venue } = args;
  const start = request.startTime ?? null;
  const partySize =
    normalizePartySize(request.party) ??
    normalizePartySize(traveler.partySize) ??
    1;

  return {
    request,
    traveler: { ...traveler, partySize },
    venue,
    isoDate: toIsoDate(start),
    displayTime: toDisplayTime(start),
    displayDate: toDisplayDate(start),
    budgetCents: normalizeBudget(request.budget),
    budgetUsd: centsToUsd(normalizeBudget(request.budget)),
  };
}

function normalizePartySize(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const v = Math.round(n);
  return v >= 1 && v <= 200 ? v : null;
}

function normalizeBudget(cents: number | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents);
}
