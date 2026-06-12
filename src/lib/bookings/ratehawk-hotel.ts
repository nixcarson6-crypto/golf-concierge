/**
 * RateHawk hotel booking — THIRD api-first path (after LiteAPI + Hotelbeds,
 * before the browser agent). Same contract as the other two: returns
 * { booked:false } on any miss/error so the chain falls through cleanly.
 *
 * Resolution mirrors Hotelbeds: Google-geocode the hotel, search ETG
 * availability in a 5 km radius, match by name. Selection stays API-blind —
 * the itinerary AI picks the hotel; this only decides HOW it's booked.
 */

import { db } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import {
  ratehawkConfigured,
  searchByGeo,
  matchByName,
  bookByHash,
} from "./providers/ratehawk";

export type RateHawkBookingResult = { booked: boolean; reason?: string };

export async function tryRateHawkHotelBooking(args: {
  bookingId: string;
  itineraryItemId: string;
  hotelName: string;
  location: string | null;
  checkin: string | null;
  checkout: string | null;
  adults: number;
  traveler: { givenName: string; familyName: string; email: string; phone?: string };
}): Promise<RateHawkBookingResult> {
  if (!ratehawkConfigured()) return { booked: false, reason: "RateHawk not configured" };
  if (!args.checkin || !args.checkout) return { booked: false, reason: "missing dates" };

  try {
    const geo = await geocodeVenue(args.hotelName, args.location);
    if (!geo) return { booked: false, reason: "couldn't geocode hotel" };

    const hotels = await searchByGeo({
      checkin: args.checkin,
      checkout: args.checkout,
      adults: Math.max(1, args.adults),
      latitude: geo.lat,
      longitude: geo.lng,
      radiusM: 5000,
    });
    const hotel = matchByName(hotels, args.hotelName);
    if (!hotel) return { booked: false, reason: "not in RateHawk" };
    if (!hotel.bookHash) return { booked: false, reason: "no bookable rate" };

    const result = await bookByHash({
      bookHash: hotel.bookHash,
      partnerOrderId: `PYL-${args.bookingId.slice(-12)}`,
      holder: {
        firstName: args.traveler.givenName,
        lastName: args.traveler.familyName,
        email: args.traveler.email,
        phone: args.traveler.phone ?? "",
      },
      adults: Math.max(1, args.adults),
    });
    // ETG confirms asynchronously — anything that didn't come back "ok"-ish
    // is not a confirmation we can show a customer. Fall through.
    if (/cancel|fail|error/i.test(result.status)) {
      return { booked: false, reason: `finish status: ${result.status}` };
    }

    await db.booking.update({
      where: { id: args.bookingId },
      data: {
        provider: "RATEHAWK",
        status: "CONFIRMED",
        confirmationCode: result.orderId,
        confirmedAt: new Date(),
        cost: hotel.total != null ? Math.round(hotel.total * 100) : null,
        metadata: {
          ratehawk: {
            orderId: result.orderId,
            hotelId: hotel.id,
            finishStatus: result.status,
          },
        } as object,
      },
    });
    await db.itineraryItem.update({
      where: { id: args.itineraryItemId },
      data: { confirmationState: "CONFIRMED", status: `Booked · ${result.orderId}` },
    });
    console.log(`[ratehawk-hotel] ✓ booked ${hotel.id} via API (order ${result.orderId}).`);
    return { booked: true };
  } catch (e) {
    console.warn(`[ratehawk-hotel] falling back: ${(e as Error).message}`);
    return { booked: false, reason: (e as Error).message };
  }
}

/** Same Places geocode helper as hotelbeds-hotel (leaf-module duplicate). */
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
      body: JSON.stringify({ textQuery, maxResultCount: 1 }),
      next: { revalidate: 604_800 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: Array<{ location?: { latitude?: number; longitude?: number } }>;
    };
    const loc = json.places?.[0]?.location;
    return loc?.latitude != null && loc?.longitude != null
      ? { lat: loc.latitude, lng: loc.longitude }
      : null;
  } catch {
    return null;
  }
}
