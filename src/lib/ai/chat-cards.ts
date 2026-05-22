/**
 * Chat card types and parsers.
 *
 * When the AI calls a tool that returns booking-style structured data
 * (flights, hotels, tee times), we turn the raw tool-result JSON into a
 * compact ChatCard the client can render as a real card inline in the
 * conversation. Cards are persisted in the assistant message's metadata so
 * they survive a refresh.
 */

export type FlightCard = {
  kind: "flight";
  offerId: string;
  airline: string;
  airlineCode?: string | null;
  origin: string;
  destination: string;
  departISO: string;
  arriveISO: string;
  durationMinutes: number;
  stops: number;
  cabinClass?: string | null;
  totalAmount: number;
  currency: string;
  paxCount: number;
};

export type HotelCard = {
  kind: "hotel";
  rateKey: string;
  hotelName: string;
  city?: string | null;
  category?: number | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  perNight: number;
  total: number;
  currency: string;
  board?: string | null;
  refundable?: boolean | null;
  imageUrl?: string | null;
};

export type TeeTimeCard = {
  kind: "tee_time";
  courseName: string;
  teeOffISO: string;
  players: number;
  greenFeePerPlayer?: number | null;
  currency?: string | null;
  isStub?: boolean;
};

export type BookingConfirmationCard = {
  kind: "booking_confirmation";
  /** What got booked. */
  bookingType: "flight" | "hotel" | "tee_time" | "restaurant" | "car";
  /** Confirmation / PNR / booking reference. */
  bookingReference: string;
  /** Vendor name (airline, hotel, course, restaurant). */
  vendor: string;
  /** Short one-liner summary, e.g. "DFW → COS Jul 4, return Jul 8 · 4 pax". */
  summary: string;
  /** Total charged, in cents. */
  totalAmount: number;
  currency: string;
  /** Passengers / guests / players — display only. */
  partyNames?: string[];
  /** Lead booker email — for "we've sent confirmation to…" line. */
  contactEmail?: string;
  /** Deep link to verify booking on the vendor's site. */
  verifyUrl?: string | null;
  /** Human label for the verify button, e.g. "Verify on aa.com". */
  verifyLabel?: string | null;
  /** True if this is a pencilled-in stub pending partner API access. */
  isStub?: boolean;
};

export type ChatCard = FlightCard | HotelCard | TeeTimeCard | BookingConfirmationCard;

type AnyRecord = Record<string, unknown>;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Parse the JSON returned by search_flights into a list of FlightCards. */
export function parseFlightSearchResult(
  raw: string,
  paxCount: number = 1,
): FlightCard[] {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(raw) as AnyRecord;
  } catch {
    return [];
  }
  if (parsed.error) return [];
  const offers = (parsed.offers as AnyRecord[] | undefined) ?? [];
  return offers.slice(0, 5).flatMap((o): FlightCard[] => {
    const slices = (o.slices as AnyRecord[] | undefined) ?? [];
    if (slices.length === 0) return [];
    const first = slices[0];
    const segments = (first.segments as AnyRecord[] | undefined) ?? [];
    if (segments.length === 0) return [];
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    const origin = str(firstSeg.origin) ?? str(first.origin) ?? "—";
    const destination = str(lastSeg.destination) ?? str(first.destination) ?? "—";
    const departISO = str(firstSeg.departing_at) ?? str(first.departingAt) ?? "";
    const arriveISO = str(lastSeg.arriving_at) ?? str(first.arrivingAt) ?? "";
    const durationMin = num(first.durationMinutes) ?? num(first.duration_minutes) ?? 0;
    const marketing = firstSeg.marketing_carrier as AnyRecord | undefined;
    const operating = firstSeg.operating_carrier as AnyRecord | undefined;
    const owner = o.owner as AnyRecord | undefined;
    const airline =
      str(marketing?.name) ??
      str(operating?.name) ??
      str(owner?.name) ??
      "Unknown";
    const airlineCode =
      str(marketing?.iata_code) ?? str(owner?.iata_code) ?? null;
    const totalAmount = num(o.totalAmount) ?? num(o.total_amount) ?? 0;
    const currency = str(o.totalCurrency) ?? str(o.total_currency) ?? "USD";
    const offerId = str(o.id) ?? "";
    if (!offerId) return [];
    return [
      {
        kind: "flight",
        offerId,
        airline,
        airlineCode,
        origin,
        destination,
        departISO,
        arriveISO,
        durationMinutes: durationMin,
        stops: Math.max(0, segments.length - 1),
        cabinClass: str(o.cabinClass) ?? null,
        totalAmount,
        currency,
        paxCount,
      },
    ];
  });
}

/** Parse the JSON returned by search_hotels into a list of HotelCards. */
export function parseHotelSearchResult(raw: string): HotelCard[] {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(raw) as AnyRecord;
  } catch {
    return [];
  }
  if (parsed.error) return [];
  const hotels = (parsed.hotels as AnyRecord[] | undefined) ?? [];
  const checkIn = str(parsed.checkIn) ?? str(parsed.check_in) ?? "";
  const checkOut = str(parsed.checkOut) ?? str(parsed.check_out) ?? "";
  const nights =
    num(parsed.nights) ??
    (checkIn && checkOut
      ? Math.max(
          1,
          Math.round(
            (new Date(checkOut).getTime() - new Date(checkIn).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        )
      : 1);

  return hotels.slice(0, 6).flatMap((h): HotelCard[] => {
    const rates = (h.rates as AnyRecord[] | undefined) ?? [];
    const cheapest = rates[0] ?? h;
    const rateKey = str(cheapest.rateKey) ?? str(h.rateKey) ?? "";
    if (!rateKey) return [];
    const total = num(cheapest.netTotal) ?? num(cheapest.net) ?? num(cheapest.total) ?? 0;
    const perNight =
      num(cheapest.perNight) ??
      (nights > 0 ? Math.round(total / nights) : total);
    return [
      {
        kind: "hotel",
        rateKey,
        hotelName: str(h.name) ?? "Unknown hotel",
        city: str(h.city) ?? null,
        category: num(h.category) ?? num(h.categoryCode) ?? null,
        checkIn,
        checkOut,
        nights,
        perNight,
        total,
        currency: str(cheapest.currency) ?? str(parsed.currency) ?? "USD",
        board: str(cheapest.boardName) ?? str(cheapest.board) ?? null,
        refundable:
          typeof cheapest.refundable === "boolean"
            ? (cheapest.refundable as boolean)
            : null,
        imageUrl: str(h.imageUrl) ?? null,
      },
    ];
  });
}

/**
 * Build a link to the airline's "manage trip" landing page. Airlines
 * have stopped honoring query-param pre-fill (it just lands on a 404),
 * so we no longer try to deep-link the PNR — we send the user to the
 * stable manage-trip page and they paste the PNR (which we copy to
 * clipboard separately). Returns null for sandbox/test bookings where
 * the PNR isn't claimable on the airline's side anyway.
 */
type AirlineEntry = {
  /** IATA airline code (e.g. "AA", "BA"). */
  code: string;
  /** Substrings to match in the carrier name (lowercase). */
  nameMatches: string[];
  /** Manage-trip / lookup URL. */
  url: string;
  /** Human label for the verify button, e.g. "Open aa.com". */
  label: string;
};

// Manage-trip landing pages for every airline we expect to see via Duffel.
// Airlines killed URL pre-fill of PNR years ago for security, so these all
// land on the lookup form — the caller copies the PNR to clipboard so it's
// a single paste. Order doesn't matter; we match by exact code first, then
// by name substring.
const AIRLINE_REGISTRY: AirlineEntry[] = [
  // US carriers
  { code: "AA", nameMatches: ["american"], url: "https://www.aa.com/managetrip/manage-trip.do", label: "Open aa.com" },
  { code: "DL", nameMatches: ["delta"], url: "https://www.delta.com/mytrips", label: "Open delta.com" },
  { code: "UA", nameMatches: ["united"], url: "https://www.united.com/en/us/manageres/mytrips", label: "Open united.com" },
  { code: "WN", nameMatches: ["southwest"], url: "https://www.southwest.com/air/manage-reservation/", label: "Open southwest.com" },
  { code: "AS", nameMatches: ["alaska"], url: "https://www.alaskaair.com/booking/reservation-lookup", label: "Open alaskaair.com" },
  { code: "B6", nameMatches: ["jetblue"], url: "https://www.jetblue.com/manage-trips", label: "Open jetblue.com" },
  { code: "F9", nameMatches: ["frontier"], url: "https://www.flyfrontier.com/booking/my-trip", label: "Open flyfrontier.com" },
  { code: "NK", nameMatches: ["spirit"], url: "https://www.spirit.com/check-in", label: "Open spirit.com" },
  { code: "HA", nameMatches: ["hawaiian"], url: "https://www.hawaiianairlines.com/manage", label: "Open hawaiianair.com" },
  { code: "G4", nameMatches: ["allegiant"], url: "https://www.allegiantair.com/manage-travel", label: "Open allegiantair.com" },
  { code: "SY", nameMatches: ["sun country"], url: "https://suncountry.com/manage-my-booking", label: "Open suncountry.com" },
  { code: "MX", nameMatches: ["breeze"], url: "https://www.flybreeze.com/manage-trip", label: "Open flybreeze.com" },

  // Canada
  { code: "AC", nameMatches: ["air canada"], url: "https://www.aircanada.com/us/en/aco/home/book/manage-bookings.html", label: "Open aircanada.com" },
  { code: "WS", nameMatches: ["westjet"], url: "https://www.westjet.com/en-us/manage-trips", label: "Open westjet.com" },
  { code: "PD", nameMatches: ["porter"], url: "https://www.flyporter.com/en-ca/manage-booking", label: "Open flyporter.com" },

  // UK & Europe — Delta SkyTeam / Star Alliance / OneWorld common partners
  { code: "BA", nameMatches: ["british airways"], url: "https://www.britishairways.com/travel/managemybooking/public/en_us", label: "Open britishairways.com" },
  { code: "VS", nameMatches: ["virgin atlantic"], url: "https://www.virginatlantic.com/gb/en/manage-your-booking.html", label: "Open virginatlantic.com" },
  { code: "EI", nameMatches: ["aer lingus"], url: "https://www.aerlingus.com/manage-booking/", label: "Open aerlingus.com" },
  { code: "LH", nameMatches: ["lufthansa"], url: "https://www.lufthansa.com/us/en/manage-bookings", label: "Open lufthansa.com" },
  { code: "AF", nameMatches: ["air france"], url: "https://wwws.airfrance.us/manage/identification", label: "Open airfrance.com" },
  { code: "KL", nameMatches: ["klm"], url: "https://www.klm.com/manage-booking", label: "Open klm.com" },
  { code: "IB", nameMatches: ["iberia"], url: "https://www.iberia.com/us/manage-your-flights/", label: "Open iberia.com" },
  { code: "AY", nameMatches: ["finnair"], url: "https://www.finnair.com/en/manage-booking", label: "Open finnair.com" },
  { code: "SK", nameMatches: ["sas", "scandinavian"], url: "https://www.flysas.com/en/manage-my-booking/", label: "Open flysas.com" },
  { code: "LX", nameMatches: ["swiss"], url: "https://www.swiss.com/us/en/manage-your-booking", label: "Open swiss.com" },
  { code: "OS", nameMatches: ["austrian"], url: "https://www.austrian.com/Info/Booking/MyBookings.aspx", label: "Open austrian.com" },
  { code: "TP", nameMatches: ["tap portugal", "tap air"], url: "https://www.flytap.com/en-us/manage-booking", label: "Open flytap.com" },
  { code: "TK", nameMatches: ["turkish airlines"], url: "https://www.turkishairlines.com/en-us/flights/manage-booking/", label: "Open turkishairlines.com" },
  { code: "FR", nameMatches: ["ryanair"], url: "https://www.ryanair.com/us/en/check-in", label: "Open ryanair.com" },
  { code: "U2", nameMatches: ["easyjet"], url: "https://www.easyjet.com/en/manage-bookings", label: "Open easyjet.com" },

  // Middle East
  { code: "EK", nameMatches: ["emirates"], url: "https://www.emirates.com/us/english/manage-booking/manage-my-booking.aspx", label: "Open emirates.com" },
  { code: "QR", nameMatches: ["qatar"], url: "https://www.qatarairways.com/en-us/manage-booking/", label: "Open qatarairways.com" },
  { code: "EY", nameMatches: ["etihad"], url: "https://www.etihad.com/en-us/manage", label: "Open etihad.com" },

  // Asia-Pacific
  { code: "SQ", nameMatches: ["singapore airlines"], url: "https://www.singaporeair.com/en_UK/us/plan-travel/manage-booking/", label: "Open singaporeair.com" },
  { code: "CX", nameMatches: ["cathay"], url: "https://www.cathaypacific.com/cx/en_US/manage-booking.html", label: "Open cathaypacific.com" },
  { code: "NH", nameMatches: ["ana", "all nippon"], url: "https://www.ana.co.jp/en/us/book-plan/reservation-management/", label: "Open ana.co.jp" },
  { code: "JL", nameMatches: ["japan airlines", "jal"], url: "https://www.jal.co.jp/us/en/inter/reservation/management/", label: "Open jal.co.jp" },
  { code: "KE", nameMatches: ["korean air"], url: "https://www.koreanair.com/us/en/booking/manage-booking", label: "Open koreanair.com" },
  { code: "OZ", nameMatches: ["asiana"], url: "https://flyasiana.com/C/US/EN/contents/reservation-management", label: "Open flyasiana.com" },
  { code: "QF", nameMatches: ["qantas"], url: "https://www.qantas.com/us/en/manage-booking.html", label: "Open qantas.com" },
  { code: "VA", nameMatches: ["virgin australia"], url: "https://www.virginaustralia.com/au/en/manage/manage-booking/", label: "Open virginaustralia.com" },
  { code: "NZ", nameMatches: ["air new zealand"], url: "https://www.airnewzealand.com/manage-booking", label: "Open airnewzealand.com" },
  { code: "TG", nameMatches: ["thai airways"], url: "https://www.thaiairways.com/en/manage_my_booking/manage_my_booking.page", label: "Open thaiairways.com" },
  { code: "MH", nameMatches: ["malaysia airlines"], url: "https://www.malaysiaairlines.com/us/en/plan-your-trip/manage-booking.html", label: "Open malaysiaairlines.com" },
  { code: "CI", nameMatches: ["china airlines"], url: "https://www.china-airlines.com/us/en/manage/manage-booking-status", label: "Open china-airlines.com" },
  { code: "BR", nameMatches: ["eva air"], url: "https://www.evaair.com/en-us/manage-my-trip/", label: "Open evaair.com" },

  // Latin America
  { code: "LA", nameMatches: ["latam"], url: "https://www.latamairlines.com/us/en/manage-trips", label: "Open latamairlines.com" },
  { code: "AM", nameMatches: ["aeromexico"], url: "https://www.aeromexico.com/en-us/your-trip", label: "Open aeromexico.com" },
  { code: "AV", nameMatches: ["avianca"], url: "https://www.avianca.com/en/check-and-manage-flight/manage-your-flight/", label: "Open avianca.com" },
  { code: "CM", nameMatches: ["copa"], url: "https://www.copaair.com/en-us/manage-your-trip/", label: "Open copaair.com" },

  // Africa
  { code: "ET", nameMatches: ["ethiopian"], url: "https://www.ethiopianairlines.com/aa/book/manage-trip", label: "Open ethiopianairlines.com" },
  { code: "SA", nameMatches: ["south african"], url: "https://www.flysaa.com/manage-flight/manage-booking", label: "Open flysaa.com" },
];

/**
 * Build a link to the airline's "manage trip" landing page. Airlines have
 * stopped honoring query-param pre-fill (it just lands on a 404), so we
 * no longer try to deep-link the PNR — we send the user to the stable
 * manage-trip page and they paste the PNR (which the caller copies to
 * clipboard separately). Covers ~50 carriers globally; for anything
 * unknown we fall back to a Google search for the airline's manage-trip
 * page so the user is never stuck. Returns null for sandbox bookings.
 */
export function airlineVerifyUrl(
  airline: string,
  airlineCode: string | null | undefined,
  _lastName: string | null | undefined,
  _pnr: string,
  opts: { sandbox?: boolean } = {},
): { url: string; label: string } | null {
  if (opts.sandbox) return null;

  const code = (airlineCode ?? "").toUpperCase();
  const name = (airline ?? "").toLowerCase();

  // Exact IATA code match first — fastest and least error-prone.
  if (code) {
    const byCode = AIRLINE_REGISTRY.find((a) => a.code === code);
    if (byCode) return { url: byCode.url, label: byCode.label };
  }
  // Fall back to name substring (handles cases where Duffel gives us a
  // marketing name like "American Airlines" but no IATA code).
  if (name) {
    const byName = AIRLINE_REGISTRY.find((a) =>
      a.nameMatches.some((m) => name.includes(m)),
    );
    if (byName) return { url: byName.url, label: byName.label };
  }
  // Unknown carrier: Google search for their manage-trip page. Better than
  // nothing — the customer types nothing, just clicks the first result.
  if (airline && airline.trim().length > 0) {
    const query = encodeURIComponent(`${airline} manage booking`);
    return {
      url: `https://www.google.com/search?q=${query}`,
      label: `Find ${airline} manage trip`,
    };
  }
  return null;
}

/** Friendly progress label shown while a tool is running. */
export function toolStartLabel(toolName: string, input: unknown): string {
  const inp = (input ?? {}) as AnyRecord;
  switch (toolName) {
    case "search_flights": {
      const slices = (inp.slices as AnyRecord[] | undefined) ?? [];
      const first = slices[0];
      if (first?.origin && first?.destination) {
        return `Searching flights ${first.origin} → ${first.destination}…`;
      }
      return "Searching live flights…";
    }
    case "book_flight":
      return "Ticketing your flight…";
    case "search_hotels": {
      const code = str(inp.destinationCode);
      if (code) return `Searching hotels in ${code}…`;
      return "Searching hotel availability…";
    }
    case "book_hotel":
      return `Reserving ${str(inp.hotelName) ?? "hotel"}…`;
    case "book_tee_time":
      return `Booking tee time at ${str(inp.courseName) ?? "the course"}…`;
    case "book_restaurant":
      return `Reserving ${str(inp.restaurantName) ?? "the restaurant"}…`;
    case "book_car":
      return "Reserving rental car…";
    case "tavily_search":
      return `Searching the web — "${str(inp.query) ?? "…"}"…`;
    case "web_search":
      return "Searching the web…";
    default:
      return `Running ${toolName}…`;
  }
}
