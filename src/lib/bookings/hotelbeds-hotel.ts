/**
 * Hotelbeds hotel booking — the SECOND api-first path, tried after LiteAPI
 * misses and before the browser agent. Same contract as liteapi-hotel.ts:
 * returns { booked:false } on any miss or error so the caller cleanly falls
 * through; never leaves a half-finished booking.
 *
 * Resolution strategy differs from LiteAPI: Hotelbeds availability wants a
 * destination code or coordinates, not a city name — so we geocode the hotel
 * via Google Places (which we already pay for) and search availability in a
 * tight radius around it, then match the returned hotels by name. That skips
 * the entire destination-code mapping problem.
 *
 * IMPORTANT: purely a BOOKING-METHOD optimization. The itinerary AI still
 * picks the best hotel with zero knowledge of Hotelbeds coverage.
 */

import { db } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  hotelbedsConfigured,
  searchAvailability,
  matchHotelByName,
  checkRate,
  book,
} from "./providers/hotelbeds";

export type HotelbedsBookingResult = { booked: boolean; reason?: string };

export async function tryHotelbedsHotelBooking(args: {
  bookingId: string;
  itineraryItemId: string;
  hotelName: string;
  location: string | null;
  checkin: string | null; // YYYY-MM-DD
  checkout: string | null; // YYYY-MM-DD
  adults: number;
  traveler: { givenName: string; familyName: string; email: string };
}): Promise<HotelbedsBookingResult> {
  if (!hotelbedsConfigured()) return { booked: false, reason: "Hotelbeds not configured" };
  if (!args.checkin || !args.checkout) return { booked: false, reason: "missing dates" };

  try {
    // 1) Geocode the hotel so we can search availability around it.
    const geo = await geocodeVenue(args.hotelName, args.location);
    if (!geo) return { booked: false, reason: "couldn't geocode hotel" };

    // 2) Availability in a tight radius — the named hotel should be in here
    //    if Hotelbeds carries it.
    const hotels = await searchAvailability({
      checkIn: args.checkin,
      checkOut: args.checkout,
      adults: Math.max(1, args.adults),
      geolocation: { latitude: geo.lat, longitude: geo.lng, radiusKm: 5 },
    });
    const hotel = matchHotelByName(hotels, args.hotelName);
    if (!hotel) return { booked: false, reason: "not in Hotelbeds" };
    const cheapest = hotel.rates[0];
    if (!cheapest) return { booked: false, reason: "no rate for dates" };

    // 3) RECHECK rates must be revalidated; BOOKABLE rates book directly.
    let rateKey = cheapest.rateKey;
    let net = cheapest.net;
    let currency = hotel.currency;
    if (cheapest.rateType === "RECHECK") {
      const fresh = await checkRate(cheapest.rateKey);
      rateKey = fresh.rateKey;
      net = fresh.net ?? net;
      currency = fresh.currency;
    }

    // 4) Book against the credit line (merchant model — we invoice via Stripe).
    const result = await book({
      rateKey,
      holder: { firstName: args.traveler.givenName, lastName: args.traveler.familyName },
      adults: Math.max(1, args.adults),
      clientReference: `PYL-${args.bookingId.slice(-12)}`,
    });

    const total = result.totalNet ?? net;
    await db.booking.update({
      where: { id: args.bookingId },
      data: {
        provider: "HOTELBEDS",
        status: "CONFIRMED",
        confirmationCode: result.reference,
        confirmedAt: new Date(),
        cost: total != null ? Math.round(total * 100) : null,
        metadata: {
          hotelbeds: {
            reference: result.reference,
            hotelCode: hotel.code,
            hotelName: hotel.name,
            currency: result.currency ?? currency,
          },
        } as object,
      },
    });
    await db.itineraryItem.update({
      where: { id: args.itineraryItemId },
      data: {
        confirmationState: "CONFIRMED",
        status: `Booked · ${result.reference}`,
      },
    });

    console.log(
      `[hotelbeds-hotel] ✓ booked ${hotel.name} via API (${result.reference}).`,
    );
    return { booked: true };
  } catch (e) {
    // Any failure → fall through to the next provider / browser agent.
    console.warn(`[hotelbeds-hotel] falling back: ${(e as Error).message}`);
    return { booked: false, reason: (e as Error).message };
  }
}

/** Geocode "hotel name, location" → lat/lng via Google Places searchText.
 *  Best-effort: null on any failure (caller falls back to the agent). */
async function geocodeVenue(
  name: string,
  location: string | null,
): Promise<{ lat: number; lng: number } | null> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) return null;
  const textQuery = location ? `${name}, ${location}` : name;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.location",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 1, rankPreference: "RELEVANCE" }),
      next: { revalidate: 604_800 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: Array<{ location?: { latitude?: number; longitude?: number } }>;
    };
    const loc = json.places?.[0]?.location;
    if (loc?.latitude == null || loc?.longitude == null) return null;
    return { lat: loc.latitude, lng: loc.longitude };
  } catch {
    return null;
  }
}
