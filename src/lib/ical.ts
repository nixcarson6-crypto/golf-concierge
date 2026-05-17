/**
 * Minimal iCal serialiser for trip itineraries. No third-party dep — the
 * spec is small and we control every field. Produces a single VCALENDAR with
 * one VEVENT per itinerary item that has a startTime.
 */

import type { ItineraryItem, ItineraryItemType, Trip } from "@prisma/client";

const CRLF = "\r\n";

export function tripToIcal(args: {
  trip: Trip;
  items: ItineraryItem[];
}) {
  const { trip, items } = args;
  const events = items
    .filter((i) => i.startTime)
    .map((i) => vevent(trip, i))
    .join(CRLF);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Golf Concierge//Trip Itinerary//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(trip.title)}`,
    `X-WR-TIMEZONE:UTC`,
    events,
    "END:VCALENDAR",
  ].join(CRLF);
}

function vevent(trip: Trip, item: ItineraryItem) {
  const uid = `${item.id}@golf-concierge`;
  const dtstamp = ical(new Date());
  const dtstart = ical(item.startTime!);
  const dtend = item.endTime
    ? ical(item.endTime)
    : ical(new Date(item.startTime!.getTime() + 60 * 60 * 1000));
  const summary = escape(item.title);
  const location = item.address || item.location || "";
  const description = [
    typeLabel(item.type),
    item.description ?? "",
    item.aiRationale ? `Why: ${item.aiRationale}` : "",
    item.cost != null
      ? `Cost (group): $${Math.round(item.cost / 100).toLocaleString()}`
      : "",
    `Trip: ${trip.title}`,
  ]
    .filter(Boolean)
    .join("\\n");

  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${summary}`,
    location ? `LOCATION:${escape(location)}` : "",
    `DESCRIPTION:${escape(description)}`,
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join(CRLF);
}

function ical(d: Date) {
  // YYYYMMDDTHHMMSSZ in UTC
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function typeLabel(t: ItineraryItemType) {
  switch (t) {
    case "TEE_TIME":
      return "[Tee time]";
    case "LODGING":
      return "[Lodging]";
    case "DINING":
      return "[Dining]";
    case "NIGHTLIFE":
      return "[Nightlife]";
    case "TRANSPORT":
      return "[Transport]";
    case "FLIGHT":
      return "[Flight]";
    case "FREE_TIME":
      return "[Free time]";
    case "SPA":
      return "[Spa]";
    case "ACTIVITY":
      return "[Activity]";
  }
}
