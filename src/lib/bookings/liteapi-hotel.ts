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
import { optionalEnv } from "@/lib/env";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { chargeCustomer } from "@/lib/payments/customer-charge";
import { serviceFeeCents } from "@/lib/payments/pricing";
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
  const last = parts[parts.length - 1].toLowerCase();

  let countryCode = COUNTRY_ISO[last] ?? null;
  // Drop the country part from consideration once identified.
  const working = countryCode ? parts.slice(0, -1) : [...parts];
  if (!countryCode) {
    // "NC 28374" / "CA 93953" → US; or any US state token anywhere.
    const tokens = parts.map((p) => p.toLowerCase().split(/\s+/)[0]);
    if (tokens.some((t) => US_STATES.has(t))) countryCode = "US";
  }
  if (!countryCode) return null;

  // CITY ≠ parts[0]. Google Places hands us FULL street addresses
  // ("10100 Dream Tree Blvd, Lake Buena Vista, FL 32836, USA" or the
  // European "Via Gesù 6/8, 20121 Milano MI, Italy"). Walk from the END
  // and, within each part, strip postal/number tokens and 2-letter
  // state/province codes — what's left of "20121 Milano MI" is "Milano",
  // and "FL 32836" strips to nothing (skip). A bare has-digits test threw
  // the European city away with its postcode. Part 0 is the street/venue
  // in multi-part addresses — never treat it as the city.
  for (let i = working.length - 1; i >= 0; i--) {
    if (i === 0 && working.length > 1) break;
    const words = working[i]
      .split(/\s+/)
      .filter((w) => !/\d/.test(w) && !(w.length === 2 && w === w.toUpperCase()));
    if (words.length === 0) continue;
    const candidate = words.join(" ");
    if (US_STATES.has(candidate.toLowerCase())) continue;
    return { city: candidate, countryCode };
  }
  return null;
}

/** Recover the PRECISE city + ISO country for a hotel via Google Places, so
 *  LiteAPI's city-name index matches even when the itinerary phrased the
 *  location as a county/region/country ("Perthshire"/"Scotland" miss where
 *  "Auchterarder" hits). UK addresses expose the town as `postal_town`; most
 *  use `locality`. Best-effort: null on any failure → caller falls back. */
async function geocodeCity(
  name: string,
  location: string | null,
): Promise<{ city: string; countryCode: string } | null> {
  const apiKey = optionalEnv("GOOGLE_MAPS_SERVER_API_KEY");
  if (!apiKey) return null;
  const textQuery = location ? `${name}, ${location}` : name;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.addressComponents",
      },
      body: JSON.stringify({ textQuery, maxResultCount: 1, rankPreference: "RELEVANCE" }),
      next: { revalidate: 604_800 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      places?: Array<{
        addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
      }>;
    };
    const comps = json.places?.[0]?.addressComponents;
    if (!comps) return null;
    const pick = (type: string) => comps.find((c) => c.types?.includes(type));
    const cityComp =
      pick("locality") ?? pick("postal_town") ?? pick("administrative_area_level_2");
    const countryCode = pick("country")?.shortText; // ISO-3166 alpha-2
    const city = cityComp?.longText;
    if (!city || !countryCode) return null;
    return { city, countryCode };
  } catch {
    return null;
  }
}

/** LiteAPI's index uses ENGLISH city names — "Milan" returns ~100 hotels,
 *  "Milano" returns 2. Map the local names Google addresses use to the
 *  English form LiteAPI knows; we try the alias first, then the original. */
const CITY_ALIASES: Record<string, string> = {
  milano: "Milan",
  venezia: "Venice",
  roma: "Rome",
  firenze: "Florence",
  napoli: "Naples",
  torino: "Turin",
  genova: "Genoa",
  padova: "Padua",
  "münchen": "Munich",
  wien: "Vienna",
  praha: "Prague",
  lisboa: "Lisbon",
  sevilla: "Seville",
  "københavn": "Copenhagen",
}

export type LiteApiBookingResult = { booked: boolean; reason?: string };

export async function tryLiteApiHotelBooking(args: {
  bookingId: string;
  itineraryItemId: string;
  /** Whose card we charge (the trip owner / customer). */
  userId: string;
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
  // Parse the city/country from the itinerary text; if it can't be parsed,
  // recover the PRECISE city by geocoding the hotel name.
  let loc = parseLocation(args.location);
  if (!loc) loc = await geocodeCity(args.hotelName, args.location);
  if (!loc) {
    console.warn(
      `[liteapi-hotel] couldn't parse or geocode city/country from "${args.location}" — agent fallback.`,
    );
    return { booked: false, reason: "couldn't parse city/country" };
  }

  // Set when we charge the customer before committing the booking — so if the
  // commit then fails we can refund (declared out here so the catch sees it).
  let hotelChargeId: string | null = null;
  // True once the vendor room is actually committed — past this point a DB
  // hiccup must NOT refund (room is booked + paid) and must NOT report a miss
  // (a retry would double-book).
  let bookCommitted = false;
  try {
    // Resolve a name → hotelId in a given city: English alias first (LiteAPI's
    // index), then the local name.
    const tryResolve = async (l: { city: string; countryCode: string }) => {
      const alias = CITY_ALIASES[l.city.toLowerCase()];
      const cityCandidates = alias ? [alias, l.city] : [l.city];
      console.log(
        `[liteapi-hotel] resolving "${args.hotelName}" in ${cityCandidates.join(" / ")}, ${l.countryCode}…`,
      );
      for (const cityName of cityCandidates) {
        const h = await resolveHotelId({ name: args.hotelName, cityName, countryCode: l.countryCode });
        if (h) return h;
      }
      return null;
    };
    let hotel = await tryResolve(loc);
    // Missed on the parsed city → geocode the hotel for the precise town and
    // retry once. This is the whole fix: a vague "Perthshire"/"Scotland" from
    // the build becomes "Auchterarder", so the API books it instead of the
    // slow browser agent (which is then reserved for genuine API-misses).
    if (!hotel) {
      const geo = await geocodeCity(args.hotelName, args.location);
      if (geo && geo.city.toLowerCase() !== loc.city.toLowerCase()) {
        console.log(
          `[liteapi-hotel] "${loc.city}" missed — retrying with geocoded "${geo.city}", ${geo.countryCode}…`,
        );
        hotel = await tryResolve(geo);
        if (hotel) loc = geo; // use the geocoded country for the rate search too
      }
    }
    if (!hotel) {
      console.warn(
        `[liteapi-hotel] no match for "${args.hotelName}" near ${loc.city}, ${loc.countryCode} — agent fallback.`,
      );
      return { booked: false, reason: "not in LiteAPI" };
    }
    console.log(`[liteapi-hotel] matched → ${hotel.name} (${hotel.id}); fetching rates…`);

    // Rate search, with an EXPLICIT distinction between an API/network ERROR
    // and a genuine EMPTY result (0 rooms for these dates) — so a log reader
    // never has to guess WHY LiteAPI passed a hotel to the browser agent.
    let rates: Awaited<ReturnType<typeof searchHotelRates>>;
    try {
      rates = await searchHotelRates({
        checkin: args.checkin,
        checkout: args.checkout,
        adults: Math.max(1, args.adults),
        hotelIds: [hotel.id],
        countryCode: loc.countryCode,
      });
    } catch (e) {
      console.warn(
        `[liteapi-hotel] ✗ ${hotel.name} (${hotel.id}): rate search ERRORED — "${(e as Error).message.slice(0, 140)}". This is an API/network error, NOT a sold-out, so it MIGHT be worth a retry → browser agent fallback for now.`,
      );
      return { booked: false, reason: "rate search error" };
    }
    const totalOffers = rates.reduce((n, r) => n + (r.offers?.length ?? 0), 0);
    const hotelRates = rates.find((r) => r.offers.length > 0);
    if (!hotelRates) {
      console.warn(
        `[liteapi-hotel] ✗ ${hotel.name} (${hotel.id}): LiteAPI returned ${rates.length} rate record(s) / ${totalOffers} bookable offer(s) for ${args.checkin}→${args.checkout}, ${args.adults} adult(s) — ${
          totalOffers === 0
            ? "GENUINELY EMPTY (no rooms loaded/available for these dates — sandbox or sold-out, NOT a bug)"
            : "rooms returned but none bookable (restricted / sold out)"
        } → browser agent fallback.`,
      );
      return { booked: false, reason: "no rate for dates" };
    }
    console.log(
      `[liteapi-hotel] ✓ ${hotel.name}: ${totalOffers} bookable offer(s) for these dates — prebooking the cheapest…`,
    );

    // Prebook the cheapest, walking up to 5 rates. Two real failure modes:
    //  • 400 "no prebook availability" — that rate isn't prebookable; the
    //    next room type usually locks fine.
    //  • 409 "...price exceeds locked selling price, please search again" —
    //    the price MOVED between search and prebook. Walking the OTHER
    //    (equally stale) rates from the same search just 409s again — exactly
    //    what stranded The Read House (200 offers, every one stale). LiteAPI
    //    is telling us to RE-SEARCH, so on a stale-price signal we re-search
    //    ONCE for fresh prices and retry before falling back to the agent.
    let sawStalePrice = false;
    const walkRates = async (
      offers: typeof hotelRates.offers,
    ): Promise<{ pre: Awaited<ReturnType<typeof prebook>>; total: number | null } | null> => {
      for (const cand of offers.slice(0, 5)) {
        try {
          const p = await prebook(cand.offerId);
          return { pre: p, total: cand.total };
        } catch (e) {
          const msg = (e as Error).message;
          if (/search again|exceeds locked|price.*(chang|mov)/i.test(msg)) {
            sawStalePrice = true;
          }
          console.warn(
            `[liteapi-hotel] prebook failed on a rate (${msg.slice(0, 110)}) — trying next rate…`,
          );
        }
      }
      return null;
    };

    let locked = await walkRates(hotelRates.offers);
    if (!locked && sawStalePrice) {
      console.log(
        `[liteapi-hotel] prices moved — re-searching ${hotel.name} for fresh rates and retrying prebook…`,
      );
      try {
        const fresh = await searchHotelRates({
          checkin: args.checkin,
          checkout: args.checkout,
          adults: Math.max(1, args.adults),
          hotelIds: [hotel.id],
          countryCode: loc.countryCode,
        });
        const freshRates = fresh.find((r) => r.offers.length > 0);
        if (freshRates) locked = await walkRates(freshRates.offers);
      } catch (e) {
        console.warn(
          `[liteapi-hotel] re-search failed: ${(e as Error).message.slice(0, 110)}`,
        );
      }
    }
    if (!locked) {
      return {
        booked: false,
        reason: `no prebookable rate (tried ${Math.min(5, hotelRates.offers.length)}${sawStalePrice ? " + re-search" : ""})`,
      };
    }
    const pre = locked.pre;
    const lockedTotal = locked.total;

    // ── MONEY FLOW: charge the CUSTOMER (Stripe) BEFORE we commit ──────────
    // The rate is locked now (pre.total), so we charge the customer's saved
    // card for rate + fee first, THEN call book(). The customer pays (Stripe),
    // never our LiteAPI wallet. No saved card → don't book; the trip page
    // sends them to Stripe Checkout to add one (reason "needs_card"). If the
    // commit then fails we refund. (No Stripe configured at all = dev/no-keys:
    // fall through and book on the wallet so local dev still works.)
    if (stripeConfigured()) {
      const rateCents =
        pre.total != null
          ? Math.round(pre.total * 100)
          : lockedTotal != null
            ? Math.round(lockedTotal * 100)
            : null;
      if (rateCents == null || rateCents <= 0) {
        return { booked: false, reason: "no lockable rate to charge" };
      }
      const payer = await db.user.findUnique({
        where: { id: args.userId },
        select: { defaultPaymentMethodId: true },
      });
      if (!payer?.defaultPaymentMethodId) {
        return { booked: false, reason: "needs_card" };
      }
      const fee = serviceFeeCents(rateCents);
      try {
        const charge = await chargeCustomer({
          userId: args.userId,
          amountCents: rateCents + fee,
          idempotencyKey: `hotel-${args.bookingId}`,
          description: `Pyltrix hotel booking — ${hotel.name}`,
          metadata: { bookingId: args.bookingId, kind: "hotel" },
        });
        if (charge.status !== "succeeded") {
          return { booked: false, reason: `charge ${charge.status}` };
        }
        hotelChargeId = charge.paymentIntentId;
      } catch (e) {
        return { booked: false, reason: `charge failed: ${(e as Error).message}` };
      }
    }

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
    bookCommitted = true; // vendor room is now reserved + the card is charged

    const costCents =
      pre.total != null
        ? Math.round(pre.total * 100)
        : lockedTotal != null
          ? Math.round(lockedTotal * 100)
          : null;

    await db.booking.update({
      where: { id: args.bookingId },
      data: {
        provider: "LITEAPI",
        status: "CONFIRMED",
        confirmationCode: result.confirmationCode,
        confirmedAt: new Date(),
        cost: costCents,
        // The Stripe charge that paid for this (set when Stripe is configured)
        // — lets a later cancel/remove refund the customer.
        stripeChargeId: hotelChargeId ?? undefined,
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
    // If the vendor room was ALREADY committed (DB write hiccup after book()),
    // do NOT refund (room is booked + paid) and do NOT report a miss (a retry
    // would double-book). Log loudly for manual reconciliation and report it as
    // booked so the caller stops here. The booking row just didn't flip to
    // CONFIRMED — a backfill fixes that.
    if (bookCommitted) {
      console.error(
        `[liteapi-hotel] COMMITTED at vendor but persistence failed for booking ${args.bookingId} — backfill CONFIRMED by hand. Cause: ${(e as Error).message}`,
      );
      return { booked: true };
    }
    // Pre-commit failure: if we charged the customer, refund them — never keep
    // money for a booking that didn't happen.
    if (hotelChargeId) {
      try {
        await stripe().refunds.create({ payment_intent: hotelChargeId });
      } catch (refundErr) {
        console.error(
          "[liteapi-hotel] REFUND FAILED — refund this PaymentIntent by hand:",
          hotelChargeId,
          refundErr,
        );
      }
    }
    // Any failure → fall back to the agent. Never a half-broken booking.
    console.warn(`[liteapi-hotel] falling back to agent: ${(e as Error).message}`);
    return { booked: false, reason: (e as Error).message };
  }
}
