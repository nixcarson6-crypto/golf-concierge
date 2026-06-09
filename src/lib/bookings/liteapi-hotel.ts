/**
 * LiteAPI hotel booking — the API-FIRST path tried before the browser agent.
 *
 * Resolve the itinerary's hotel name → LiteAPI hotelId, search rates BY ID
 * (city-name search is unreliable), prebook, book, and persist a confirmed
 * booking — all in a few seconds. Returns { booked:false } on any miss or
 * error so the caller cleanly falls back to the browser agent; this never
 * leaves a half-finished or broken booking.
 *
 * IMPORTANT: this is purely a BOOKING-METHOD optimization. The itinerary AI
 * still picks the best hotel with zero knowledge of LiteAPI coverage; we only
 * decide "API vs agent" here, at booking time.
 */

import { db } from "@/lib/db";
import {
  liteapiConfigured,
  resolveHotelId,
  searchHotelRates,
  prebook,
  book,
} from "./providers/liteapi";

const COUNTRY_ISO: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US",
  "u.s.a": "US", "u.s": "US", america: "US",
  italy: "IT", italia: "IT", france: "FR", spain: "ES", españa: "ES",
  portugal: "PT", germany: "DE", deutschland: "DE", switzerland: "CH",
  austria: "AT", ireland: "IE", "united kingdom": "GB", uk: "GB",
  britain: "GB", scotland: "GB", england: "GB", wales: "GB", greece: "GR",
  croatia: "HR", netherlands: "NL", belgium: "BE", mexico: "MX",
  canada: "CA", turkey: "TR", türkiye: "TR",
};

const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy",
]);

/** Pull a city + ISO country code out of an itinerary item's location text. */
function parseLocation(loc: string | null): { city: string; countryCode: string } | null {
  if (!loc) return null;
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const city = parts[0];
  const last = parts[parts.length - 1].toLowerCase();

  let countryCode = COUNTRY_ISO[last] ?? null;
  if (!countryCode) {
    // "NC 28374" / "CA 93953" → US; or any US state token anywhere.
    const tokens = parts.map((p) => p.toLowerCase().split(/\s+/)[0]);
    if (tokens.some((t) => US_STATES.has(t))) countryCode = "US";
  }
  if (!countryCode) return null;
  return { city, countryCode };
}

export type LiteApiBookingResult = { booked: boolean; reason?: string };

export async function tryLiteApiHotelBooking(args: {
  bookingId: string;
  itineraryItemId: string;
  hotelName: string;
  location: string | null;
  checkin: string | null; // YYYY-MM-DD (check-in)
  checkout: string | null; // YYYY-MM-DD (check-out)
  adults: number;
  traveler: { givenName: string; familyName: string; email: string };
}): Promise<LiteApiBookingResult> {
  if (!liteapiConfigured()) return { booked: false, reason: "LiteAPI not configured" };
  if (!args.checkin || !args.checkout) return { booked: false, reason: "missing dates" };
  if (!args.traveler.email) return { booked: false, reason: "missing traveler email" };
  const loc = parseLocation(args.location);
  if (!loc) return { booked: false, reason: "couldn't parse city/country" };

  try {
    const hotel = await resolveHotelId({
      name: args.hotelName,
      cityName: loc.city,
      countryCode: loc.countryCode,
    });
    if (!hotel) return { booked: false, reason: "not in LiteAPI" };

    const rates = await searchHotelRates({
      checkin: args.checkin,
      checkout: args.checkout,
      adults: Math.max(1, args.adults),
      hotelIds: [hotel.id],
      countryCode: loc.countryCode,
    });
    const offer = rates.find((r) => r.cheapestOfferId);
    if (!offer?.cheapestOfferId) return { booked: false, reason: "no rate for dates" };

    const pre = await prebook(offer.cheapestOfferId);
    const result = await book({
      prebookId: pre.prebookId,
      holder: {
        firstName: args.traveler.givenName,
        lastName: args.traveler.familyName,
        email: args.traveler.email,
      },
      guests: [
        {
          firstName: args.traveler.givenName,
          lastName: args.traveler.familyName,
          email: args.traveler.email,
        },
      ],
    });

    const costCents =
      offer.cheapestTotal != null
        ? Math.round(offer.cheapestTotal * 100)
        : pre.total != null
          ? Math.round(pre.total * 100)
          : null;

    await db.booking.update({
      where: { id: args.bookingId },
      data: {
        provider: "LITEAPI",
        status: "CONFIRMED",
        confirmationCode: result.confirmationCode,
        confirmedAt: new Date(),
        cost: costCents,
        metadata: {
          liteapi: {
            bookingId: result.bookingId,
            hotelId: hotel.id,
            hotelName: hotel.name,
            prebookId: pre.prebookId,
          },
        } as object,
      },
    });
    await db.itineraryItem.update({
      where: { id: args.itineraryItemId },
      data: {
        confirmationState: "CONFIRMED",
        status: `Booked${result.confirmationCode ? ` · ${result.confirmationCode}` : ""}`,
      },
    });

    console.log(
      `[liteapi-hotel] ✓ booked ${hotel.name} via API (${result.confirmationCode ?? result.bookingId}).`,
    );
    return { booked: true };
  } catch (e) {
    // Any failure → fall back to the agent. Never a half-broken booking.
    console.warn(`[liteapi-hotel] falling back to agent: ${(e as Error).message}`);
    return { booked: false, reason: (e as Error).message };
  }
}
