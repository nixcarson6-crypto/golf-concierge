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

export type ChatCard = FlightCard | HotelCard | TeeTimeCard;

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
