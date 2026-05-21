import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, modelFor } from "./client";
import {
  searchFlights,
  formatOfferOneLine,
  type FlightSearchInput,
} from "@/lib/bookings/providers/duffel-search";
import {
  searchHotels,
  formatHotelOneLine,
  type HotelSearchInput,
} from "@/lib/bookings/providers/hotelbeds-search";
import {
  bookFlightOffer,
  type BookFlightInput,
} from "@/lib/bookings/providers/duffel-book";
import { recordFlightBooking } from "@/lib/bookings/record-flight";
import {
  bookHotel,
  type BookHotelInput,
} from "@/lib/bookings/providers/hotelbeds-book";
import { recordHotelBooking } from "@/lib/bookings/record-hotel";
import {
  bookTeeTime,
  type BookTeeTimeInput,
} from "@/lib/bookings/providers/lightspeed-golf-book";
import { recordTeeTimeBooking } from "@/lib/bookings/record-tee-time";
import {
  bookRestaurant,
  type BookRestaurantInput,
} from "@/lib/bookings/providers/yelp-reservations";
import { recordRestaurantBooking } from "@/lib/bookings/record-restaurant";
import {
  bookCar,
  type BookCarInput,
} from "@/lib/bookings/providers/avis-book";
import { recordCarBooking } from "@/lib/bookings/record-car";
import { tavilySearch, type TavilySearchInput } from "@/lib/ai/tavily";
import { db } from "@/lib/db";
import {
  parseFlightSearchResult,
  parseHotelSearchResult,
  toolStartLabel,
  airlineVerifyUrl,
  type ChatCard,
  type BookingConfirmationCard,
} from "@/lib/ai/chat-cards";

/**
 * Streaming reply helper with tool support.
 *
 * Two tools are exposed:
 *   - `search_flights` (client-side, Duffel): we execute, append the result
 *     to the conversation, and re-stream the continuation.
 *   - `web_search` (server-side, Anthropic): Anthropic executes the searches
 *     transparently and inlines results into the model's response. We don't
 *     need an executor for it; the events flow through the same stream and
 *     non-text blocks are silently ignored.
 *
 * Yielded tokens are just the assistant's prose — tool-use rounds invisible.
 */
export type StreamReplyOptions = {
  system: string;
  /**
   * Optional live per-turn context (e.g. trip + user profile snapshot).
   * Sent as a separate, non-cached system block so the AI sees fresh state
   * each turn without busting the prompt cache on the static voice block.
   */
  liveContext?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  cacheSystem?: boolean;
  maxTokens?: number;
  /** Trip context — required for tools that persist (e.g. book_flight). */
  tripId?: string;
  /** Current user id — used by save_user_profile to persist learned fields. */
  userId?: string;
};

/** Anthropic-hosted web search. Server-side execution; no client executor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEB_SEARCH_TOOL: any = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
};

const TAVILY_SEARCH_TOOL: Anthropic.Tool = {
  name: "tavily_search",
  description:
    "AI-optimized web search via Tavily. Use this for travel-specific, local-business, and freshness-sensitive lookups where you want structured top results with snippets and a synthesized answer: course green fees + tee sheets, restaurant menus / dress codes / availability hints, hotel amenities not in search_hotels, local weather, event calendars affecting a destination, course conditions, news/closures. Faster and cheaper than web_search for narrow factual queries. Prefer web_search for broad multi-step research or when you want the model to read full pages. Returns up to 10 results with title, url, snippet, score, and an optional one-line answer summary.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query. Be specific.",
      },
      searchDepth: {
        type: "string",
        enum: ["basic", "advanced"],
        description:
          "'basic' (default) for quick lookups, 'advanced' for harder/long-tail queries. Advanced costs more credits.",
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Max results to return (default 5).",
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
        description: "'news' biases toward recent articles; default 'general'.",
      },
      includeDomains: {
        type: "array",
        items: { type: "string" },
        description:
          "Restrict results to these domains (e.g. ['golfdigest.com', 'pinehurst.com']).",
      },
      excludeDomains: {
        type: "array",
        items: { type: "string" },
        description: "Exclude these domains from results.",
      },
    },
    required: ["query"],
  },
};

const SAVE_USER_PROFILE_TOOL: Anthropic.Tool = {
  name: "save_user_profile",
  description:
    "Persist the trip owner's (current user's) booking profile so we never re-ask. Call this as soon as the user provides any of: legal name, date of birth, gender, or phone — even partial. The values you pass overwrite what we have; only include fields you actually learned this turn. This is how Pyltrix stays hands-free across bookings.",
  input_schema: {
    type: "object",
    properties: {
      legalGivenName: { type: "string", description: "Legal first name as on government ID." },
      legalFamilyName: { type: "string", description: "Legal last name as on government ID." },
      dateOfBirth: { type: "string", description: "ISO date YYYY-MM-DD." },
      gender: { type: "string", enum: ["m", "f"], description: "Airline ticketing gender." },
      phone: { type: "string", description: "E.164 phone, e.g. +12125550100." },
    },
  },
};

const SAVE_MEMBER_PROFILE_TOOL: Anthropic.Tool = {
  name: "save_member_profile",
  description:
    "Persist a trip companion's booking profile (someone the owner invited to the trip). Identify the member by email. Use this when collecting passenger info for group bookings so subsequent bookings on this trip auto-fill the companion's details.",
  input_schema: {
    type: "object",
    properties: {
      email: { type: "string", description: "The companion's email (used as identity within the trip)." },
      legalGivenName: { type: "string" },
      legalFamilyName: { type: "string" },
      dateOfBirth: { type: "string", description: "ISO date YYYY-MM-DD." },
      gender: { type: "string", enum: ["m", "f"] },
      phone: { type: "string", description: "E.164 phone." },
    },
    required: ["email"],
  },
};

const FLIGHT_TOOL: Anthropic.Tool = {
  name: "search_flights",
  description:
    "Search live flight offers via Duffel. Use this whenever the user asks about flight prices, availability, or wants to book flights — DO NOT hedge with 'I can't pull live fares' when this tool is available. Returns real bookable offers with airlines, times, stops, and per-passenger prices. Use IATA airport codes (e.g. DFW, COS, LAX). If a city has multiple airports, pick the one the user most likely means.",
  input_schema: {
    type: "object",
    properties: {
      slices: {
        type: "array",
        description:
          "Each slice is one leg. For a round-trip, send two slices (outbound + return). Origin and destination are IATA airport codes.",
        items: {
          type: "object",
          properties: {
            origin: { type: "string", description: "IATA airport code, e.g. DFW" },
            destination: { type: "string", description: "IATA airport code, e.g. COS" },
            departureDate: {
              type: "string",
              description: "ISO date, YYYY-MM-DD",
            },
          },
          required: ["origin", "destination", "departureDate"],
        },
        minItems: 1,
        maxItems: 6,
      },
      passengers: {
        type: "integer",
        description: "Adult passenger count (1-9).",
        minimum: 1,
        maximum: 9,
      },
      cabin: {
        type: "string",
        enum: ["economy", "premium_economy", "business", "first"],
        description:
          "Cabin class — REQUIRED. Pyltrix is a luxury platform; default to 'business' unless the user explicitly wants the best deal (economy) or first class. Always confirm the user's preference once per trip, then reuse it for every flight search on the same trip.",
      },
    },
    required: ["slices", "passengers"],
  },
};

const FLIGHT_BOOK_TOOL: Anthropic.Tool = {
  name: "book_flight",
  description:
    "Ticket a Duffel flight offer the user has chosen. Call this AFTER the user explicitly confirms which option to book (e.g. 'book the AA option', 'book it'). You must collect passenger details from the user first — given name, family name, date of birth (YYYY-MM-DD), gender (m/f), email, and phone number in E.164 format (e.g. +12125550100) — one set per passenger on the offer. The `offerId` is the `id` field from the search_flights result. On success, the booking is persisted to the trip and appears in the Live Trip panel. On failure (most commonly: offer expired after a few minutes), re-run search_flights and present fresh options.",
  input_schema: {
    type: "object",
    properties: {
      offerId: {
        type: "string",
        description:
          "The Duffel offer id from a prior search_flights call. Offers expire in ~5 minutes — if it's been longer, re-search before booking.",
      },
      passengers: {
        type: "array",
        description: "One entry per passenger on the offer.",
        items: {
          type: "object",
          properties: {
            given_name: { type: "string" },
            family_name: { type: "string" },
            born_on: {
              type: "string",
              description: "ISO date YYYY-MM-DD.",
            },
            gender: { type: "string", enum: ["m", "f"] },
            email: { type: "string" },
            phone_number: {
              type: "string",
              description: "E.164 format, e.g. +12125550100.",
            },
          },
          required: [
            "given_name",
            "family_name",
            "born_on",
            "gender",
            "email",
            "phone_number",
          ],
        },
        minItems: 1,
        maxItems: 9,
      },
    },
    required: ["offerId", "passengers"],
  },
};

const HOTEL_BOOK_TOOL: Anthropic.Tool = {
  name: "book_hotel",
  description:
    "Reserve a hotel that came back from search_hotels. Call this AFTER the user confirms which hotel + room rate to book. You need the rateKey from the search result (each room/rate option has one), the hotel name + city for display, dates, room count, and one lead guest name per room plus the booking holder's name + email. On success the booking is persisted to the trip's itinerary. If credentials aren't configured this records a STUB- prefixed booking so the flow still works — never lie to the user that it's real if isStub=true is returned.",
  input_schema: {
    type: "object",
    properties: {
      rateKey: {
        type: "string",
        description: "Hotelbeds rateKey from a prior search_hotels result.",
      },
      hotelName: { type: "string" },
      city: { type: "string" },
      checkIn: { type: "string", description: "YYYY-MM-DD" },
      checkOut: { type: "string", description: "YYYY-MM-DD" },
      rooms: { type: "integer", minimum: 1, maximum: 8 },
      guests: {
        type: "array",
        description: "One lead guest per room.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            surname: { type: "string" },
          },
          required: ["name", "surname"],
        },
        minItems: 1,
        maxItems: 8,
      },
      holderName: { type: "string" },
      holderSurname: { type: "string" },
      holderEmail: { type: "string" },
    },
    required: [
      "rateKey",
      "hotelName",
      "checkIn",
      "checkOut",
      "rooms",
      "guests",
      "holderName",
      "holderSurname",
      "holderEmail",
    ],
  },
};

const TEE_TIME_BOOK_TOOL: Anthropic.Tool = {
  name: "book_tee_time",
  description:
    "Book a golf tee time at a named course. Call this when the user confirms the time and players. If you don't yet know the green fee for the course, use web_search first to look it up, then call this with greenFeePerPlayer set. The booking is persisted to the trip. If LIGHTSPEED_GOLF_API_KEY isn't configured a stub confirmation is created — surface that fact to the user (e.g. 'Pencilled in — we'll lock it once partner API access lands').",
  input_schema: {
    type: "object",
    properties: {
      courseName: { type: "string" },
      teeOffISO: {
        type: "string",
        description: "Local tee-off datetime, ISO 8601.",
      },
      players: { type: "integer", minimum: 1, maximum: 8 },
      greenFeePerPlayer: {
        type: "integer",
        description: "Green fee in USD cents per player.",
        minimum: 0,
      },
      leadPlayerName: { type: "string" },
      leadPlayerEmail: { type: "string" },
    },
    required: [
      "courseName",
      "teeOffISO",
      "players",
      "greenFeePerPlayer",
      "leadPlayerName",
      "leadPlayerEmail",
    ],
  },
};

const RESTAURANT_BOOK_TOOL: Anthropic.Tool = {
  name: "book_restaurant",
  description:
    "Reserve a restaurant via Yelp Reservations. Works for restaurants Yelp covers. If Yelp can't book the spot (Resy/OpenTable-exclusive places, busy slot, no partner support) the tool returns a fallback link — in that case, quote the link in chat so the user can finalise it themselves, and be honest that you couldn't book it directly. Never claim a reservation was made when fallback=link is returned.",
  input_schema: {
    type: "object",
    properties: {
      restaurantName: { type: "string" },
      city: { type: "string" },
      dateTimeISO: { type: "string", description: "ISO 8601 datetime" },
      partySize: { type: "integer", minimum: 1, maximum: 20 },
      contactName: { type: "string" },
      contactPhone: {
        type: "string",
        description: "E.164 format, e.g. +12125550100",
      },
      contactEmail: { type: "string" },
    },
    required: [
      "restaurantName",
      "city",
      "dateTimeISO",
      "partySize",
      "contactName",
      "contactPhone",
      "contactEmail",
    ],
  },
};

const CAR_BOOK_TOOL: Anthropic.Tool = {
  name: "book_car",
  description:
    "Reserve a rental car (Avis). Call when the user confirms pickup airport, dates, and class. If AVIS_API_KEY isn't configured, a stub booking is recorded — surface the STUB- prefix to the user honestly.",
  input_schema: {
    type: "object",
    properties: {
      pickupAirport: { type: "string", description: "IATA code" },
      pickupISO: { type: "string" },
      returnISO: { type: "string" },
      carClass: {
        type: "string",
        enum: ["economy", "midsize", "fullsize", "luxury", "suv", "luxury suv"],
      },
      driverName: { type: "string" },
      driverEmail: { type: "string" },
    },
    required: [
      "pickupAirport",
      "pickupISO",
      "returnISO",
      "carClass",
      "driverName",
      "driverEmail",
    ],
  },
};

const HOTEL_TOOL: Anthropic.Tool = {
  name: "search_hotels",
  description:
    "Search live hotel availability and rates via Hotelbeds. Use whenever the user asks for hotel prices, availability, or to book lodging. Two ways to specify location: destinationCode (3-letter Hotelbeds code like 'MAD' Madrid, 'NYC' New York, 'PMI' Palma, 'LON' London — most reliable, especially in sandbox), OR latitude+longitude+radius. Prefer destinationCode if you know it. You know codes for major markets from training; if uncertain, use lat/lng. Returns hotels sorted cheapest first with category (stars), per-night/per-room rate, total stay cost, board, refundability. Use this INSTEAD OF web_search for bookable hotel rates.",
  input_schema: {
    type: "object",
    properties: {
      destinationCode: {
        type: "string",
        description:
          "Hotelbeds 3-letter destination code, e.g. MAD, NYC, LON, PMI. Prefer this over lat/lng when you're confident in the code.",
      },
      latitude: {
        type: "number",
        description: "Latitude of search center (decimal degrees). Only used if destinationCode is omitted.",
      },
      longitude: {
        type: "number",
        description: "Longitude of search center (decimal degrees). Only used if destinationCode is omitted.",
      },
      radiusKm: {
        type: "number",
        description: "Search radius in kilometers (default 20).",
      },
      checkIn: {
        type: "string",
        description: "Check-in date, ISO YYYY-MM-DD.",
      },
      checkOut: {
        type: "string",
        description: "Check-out date, ISO YYYY-MM-DD.",
      },
      rooms: {
        type: "integer",
        description: "Number of rooms.",
        minimum: 1,
        maximum: 8,
      },
      adults: {
        type: "integer",
        description: "Total adults across all rooms.",
        minimum: 1,
        maximum: 16,
      },
      children: {
        type: "integer",
        description: "Total children. Default 0.",
        minimum: 0,
      },
    },
    required: ["checkIn", "checkOut", "rooms", "adults"],
  },
};

type AnthropicMessage = {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
        | { type: "tool_result"; tool_use_id: string; content: string }
      >;
};

export type StreamReplyEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; tool: string; label: string }
  | { type: "tool_end"; id: string; tool: string; ok: boolean }
  | { type: "card"; card: ChatCard };

/**
 * Richer event stream: emits text deltas plus tool-use indicators and
 * structured cards (flight/hotel/etc) as they become available. Use this
 * for new code; `streamReplyTokens` below is kept as a string-only
 * wrapper for any older callers.
 */
export async function* streamReplyEvents(
  opts: StreamReplyOptions,
): AsyncGenerator<StreamReplyEvent, string> {
  const client = anthropic();
  // The static voice block stays cacheable; the live trip/user context is
  // appended as a second uncached block so it can change every turn without
  // busting the prompt cache. If liveContext is absent we just send the
  // voice block (cached or plain string per cacheSystem).
  const systemParam: string | Anthropic.TextBlockParam[] = opts.cacheSystem
    ? ([
        {
          type: "text" as const,
          text: opts.system,
          cache_control: { type: "ephemeral" as const },
        },
        ...(opts.liveContext
          ? [{ type: "text" as const, text: opts.liveContext }]
          : []),
      ] as Anthropic.TextBlockParam[])
    : opts.liveContext
      ? `${opts.system}\n\n${opts.liveContext}`
      : opts.system;

  const messages: AnthropicMessage[] = opts.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let full = "";
  for (let round = 0; round < 4; round++) {
    const stream = client.messages.stream({
      model: modelFor("orchestrator"),
      max_tokens: opts.maxTokens ?? 800,
      system: systemParam,
      messages: messages as Anthropic.MessageParam[],
      tools: [
        FLIGHT_TOOL,
        FLIGHT_BOOK_TOOL,
        HOTEL_TOOL,
        HOTEL_BOOK_TOOL,
        TEE_TIME_BOOK_TOOL,
        RESTAURANT_BOOK_TOOL,
        CAR_BOOK_TOOL,
        SAVE_USER_PROFILE_TOOL,
        SAVE_MEMBER_PROFILE_TOOL,
        TAVILY_SEARCH_TOOL,
        WEB_SEARCH_TOOL,
      ] as Anthropic.Tool[],
    });

    for await (const event of stream as unknown as AsyncIterable<Anthropic.MessageStreamEvent>) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        full += event.delta.text;
        yield { type: "delta", text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason !== "tool_use") {
      return full;
    }

    messages.push({
      role: "assistant",
      content: finalMessage.content as AnthropicMessage["content"],
    });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];
    for (const block of finalMessage.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "web_search") continue;
      yield {
        type: "tool_start",
        id: block.id,
        tool: block.name,
        label: toolStartLabel(block.name, block.input),
      };
      const result = await executeTool(block.name, block.input, {
        tripId: opts.tripId,
        userId: opts.userId,
      });
      let ok = true;
      try {
        const parsedResult = JSON.parse(result) as { error?: unknown };
        if (parsedResult && typeof parsedResult.error === "string") ok = false;
      } catch {
        ok = false;
      }
      yield { type: "tool_end", id: block.id, tool: block.name, ok };

      if (ok) {
        if (block.name === "search_flights") {
          const inp = block.input as { passengers?: number } | null;
          const pax = typeof inp?.passengers === "number" ? inp.passengers : 1;
          for (const card of parseFlightSearchResult(result, pax)) {
            yield { type: "card", card };
          }
        } else if (block.name === "search_hotels") {
          for (const card of parseHotelSearchResult(result)) {
            yield { type: "card", card };
          }
        } else if (
          block.name === "book_flight" ||
          block.name === "book_hotel" ||
          block.name === "book_tee_time" ||
          block.name === "book_restaurant" ||
          block.name === "book_car"
        ) {
          const card = buildConfirmationCard(block.name, block.input, result);
          if (card) yield { type: "card", card };
        }
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }
    if (toolResults.length === 0) return full;
    messages.push({ role: "user", content: toolResults });
  }

  return full;
}

/**
 * Translate a successful book_* tool result into a visible confirmation
 * card. Returns null if the result is missing the fields we need —
 * the AI's prose announcement still ships, just without a card.
 */
function buildConfirmationCard(
  toolName: string,
  toolInput: unknown,
  rawResult: string,
): BookingConfirmationCard | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawResult) as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const bookingReference = s(parsed.bookingReference);
  if (!bookingReference) return null;
  const isStub = Boolean(parsed.isStub);
  const currency = s(parsed.currency) ?? "USD";

  if (toolName === "book_flight") {
    const inp = (toolInput ?? {}) as { passengers?: Array<{ given_name?: string; family_name?: string; email?: string }> };
    const passengers = parsed.passengers as Array<{ given_name?: string; family_name?: string }> | undefined;
    const partyNames = (passengers ?? inp.passengers ?? [])
      .map((p) => [p.given_name, p.family_name].filter(Boolean).join(" ").trim())
      .filter((n) => n.length > 0);
    const leadLastName = passengers?.[0]?.family_name ?? inp.passengers?.[0]?.family_name ?? null;
    const airline = s(parsed.airline) ?? "Airline";
    const totalUSD = n(parsed.totalUSD) ?? 0;
    const slicesSummary = s(parsed.slicesSummary) ?? "";
    const contactEmail = s(inp.passengers?.[0]?.email);
    const isSandbox = Boolean(parsed.isSandbox);
    const verify =
      isStub || isSandbox
        ? null
        : airlineVerifyUrl(airline, null, leadLastName, bookingReference, {
            sandbox: isSandbox,
          });
    return {
      kind: "booking_confirmation",
      bookingType: "flight",
      bookingReference,
      vendor: airline,
      summary: slicesSummary || "Flight booked",
      totalAmount: totalUSD * 100,
      currency,
      partyNames,
      contactEmail: contactEmail ?? undefined,
      verifyUrl: verify?.url ?? null,
      verifyLabel: verify?.label ?? null,
      isStub,
    };
  }

  if (toolName === "book_hotel") {
    const inp = (toolInput ?? {}) as {
      hotelName?: string;
      city?: string;
      checkIn?: string;
      checkOut?: string;
      rooms?: number;
      guests?: Array<{ name?: string; surname?: string }>;
      holderEmail?: string;
    };
    const hotelName = s(parsed.hotelName) ?? s(inp.hotelName) ?? "Hotel";
    const city = s(inp.city);
    const checkIn = s(inp.checkIn) ?? "";
    const checkOut = s(inp.checkOut) ?? "";
    const rooms = n(inp.rooms) ?? 1;
    const partyNames = (inp.guests ?? [])
      .map((g) => [g.name, g.surname].filter(Boolean).join(" ").trim())
      .filter((x) => x.length > 0);
    const totalUSD = n(parsed.totalUSD) ?? 0;
    const summary = [
      city ? `${hotelName} · ${city}` : hotelName,
      checkIn && checkOut ? `${checkIn} → ${checkOut}` : null,
      `${rooms} room${rooms > 1 ? "s" : ""}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      kind: "booking_confirmation",
      bookingType: "hotel",
      bookingReference,
      vendor: hotelName,
      summary,
      totalAmount: totalUSD * 100,
      currency,
      partyNames,
      contactEmail: s(inp.holderEmail) ?? undefined,
      verifyUrl: null,
      verifyLabel: null,
      isStub,
    };
  }

  if (toolName === "book_tee_time") {
    const inp = (toolInput ?? {}) as {
      courseName?: string;
      teeOffISO?: string;
      players?: number;
      leadPlayerName?: string;
      leadPlayerEmail?: string;
    };
    const courseName = s(inp.courseName) ?? "Course";
    const teeOff = s(inp.teeOffISO) ?? "";
    const players = n(inp.players) ?? 1;
    const totalUSD = n(parsed.totalUSD) ?? 0;
    return {
      kind: "booking_confirmation",
      bookingType: "tee_time",
      bookingReference,
      vendor: courseName,
      summary: `${courseName} · ${teeOff} · ${players} player${players > 1 ? "s" : ""}`,
      totalAmount: totalUSD * 100,
      currency,
      partyNames: inp.leadPlayerName ? [inp.leadPlayerName] : [],
      contactEmail: s(inp.leadPlayerEmail) ?? undefined,
      verifyUrl: null,
      verifyLabel: null,
      isStub,
    };
  }

  if (toolName === "book_restaurant") {
    const inp = (toolInput ?? {}) as {
      restaurantName?: string;
      city?: string;
      dateTimeISO?: string;
      partySize?: number;
      contactName?: string;
      contactEmail?: string;
    };
    const name = s(inp.restaurantName) ?? "Restaurant";
    const dt = s(inp.dateTimeISO) ?? "";
    const partySize = n(inp.partySize) ?? 2;
    return {
      kind: "booking_confirmation",
      bookingType: "restaurant",
      bookingReference,
      vendor: name,
      summary: [
        inp.city ? `${name} · ${inp.city}` : name,
        dt,
        `Party of ${partySize}`,
      ]
        .filter(Boolean)
        .join(" · "),
      totalAmount: 0,
      currency,
      partyNames: inp.contactName ? [inp.contactName] : [],
      contactEmail: s(inp.contactEmail) ?? undefined,
      verifyUrl: null,
      verifyLabel: null,
      isStub,
    };
  }

  if (toolName === "book_car") {
    const vendor = s(parsed.vendor) ?? "Rental";
    const carClass = s(parsed.carClass) ?? "";
    const totalUSD = n(parsed.totalUSD) ?? 0;
    return {
      kind: "booking_confirmation",
      bookingType: "car",
      bookingReference,
      vendor,
      summary: carClass ? `${vendor} · ${carClass}` : vendor,
      totalAmount: totalUSD * 100,
      currency,
      partyNames: [],
      verifyUrl: null,
      verifyLabel: null,
      isStub,
    };
  }

  return null;
}

export async function* streamReplyTokens(
  opts: StreamReplyOptions,
): AsyncGenerator<string, string> {
  const client = anthropic();
  const systemParam = opts.cacheSystem
    ? [
        {
          type: "text" as const,
          text: opts.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : opts.system;

  const messages: AnthropicMessage[] = opts.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let full = "";
  // Cap tool-use rounds defensively so a misbehaving model can't loop forever.
  for (let round = 0; round < 4; round++) {
    const stream = client.messages.stream({
      model: modelFor("orchestrator"),
      max_tokens: opts.maxTokens ?? 800,
      system: systemParam,
      messages: messages as Anthropic.MessageParam[],
      tools: [
        FLIGHT_TOOL,
        FLIGHT_BOOK_TOOL,
        HOTEL_TOOL,
        HOTEL_BOOK_TOOL,
        TEE_TIME_BOOK_TOOL,
        RESTAURANT_BOOK_TOOL,
        CAR_BOOK_TOOL,
        SAVE_USER_PROFILE_TOOL,
        SAVE_MEMBER_PROFILE_TOOL,
        TAVILY_SEARCH_TOOL,
        WEB_SEARCH_TOOL,
      ] as Anthropic.Tool[],
    });

    for await (const event of stream as unknown as AsyncIterable<Anthropic.MessageStreamEvent>) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        full += event.delta.text;
        yield event.delta.text;
      }
    }

    const finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason !== "tool_use") {
      // We're done — model produced its final reply.
      return full;
    }

    // Append the assistant turn (text + tool_use) and the tool results, then
    // loop for the continuation.
    messages.push({
      role: "assistant",
      content: finalMessage.content as AnthropicMessage["content"],
    });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];
    for (const block of finalMessage.content) {
      if (block.type !== "tool_use") continue;
      // web_search is server-executed by Anthropic — skip; its results are
      // already inlined in the assistant message we just appended above.
      if (block.name === "web_search") continue;
      const result = await executeTool(block.name, block.input, {
        tripId: opts.tripId,
        userId: opts.userId,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }
    if (toolResults.length === 0) {
      // Stop reason was tool_use but only server-side tools fired — nothing
      // for us to do, model will continue on its own next round.
      return full;
    }
    messages.push({ role: "user", content: toolResults });
  }

  return full;
}

async function executeTool(
  name: string,
  input: unknown,
  ctx: { tripId?: string; userId?: string },
): Promise<string> {
  if (name === "search_hotels") return executeHotelSearch(input);
  if (name === "book_flight") return executeBookFlight(input, ctx);
  if (name === "book_hotel") return executeBookHotel(input, ctx);
  if (name === "book_tee_time") return executeBookTeeTime(input, ctx);
  if (name === "book_restaurant") return executeBookRestaurant(input, ctx);
  if (name === "book_car") return executeBookCar(input, ctx);
  if (name === "tavily_search") return tavilySearch(input as TavilySearchInput);
  if (name === "save_user_profile") return executeSaveUserProfile(input, ctx);
  if (name === "save_member_profile")
    return executeSaveMemberProfile(input, ctx);
  if (name !== "search_flights") {
    return JSON.stringify({ error: `unknown tool: ${name}` });
  }
  const parsed = input as Partial<FlightSearchInput> | null;
  if (
    !parsed ||
    !Array.isArray(parsed.slices) ||
    parsed.slices.length === 0 ||
    typeof parsed.passengers !== "number"
  ) {
    return JSON.stringify({ error: "invalid input — need slices[] and passengers" });
  }

  const result = await searchFlights({
    slices: parsed.slices,
    passengers: parsed.passengers,
    cabin: parsed.cabin,
    maxOffers: 5,
  });

  if (!result.ok) {
    return JSON.stringify({ error: result.error });
  }

  // Compact, model-friendly summary. Include enough for the LLM to reason and
  // quote real numbers without dumping the entire Duffel payload.
  return JSON.stringify({
    offerRequestId: result.offerRequestId,
    offerCount: result.offers.length,
    offers: result.offers.map((o) => ({
      id: o.id,
      summary: formatOfferOneLine(o),
      airline: o.airlineName,
      airlineWebsite: o.airlineWebsite,
      bookingSearchUrl: o.bookingSearchUrl,
      totalUSD: Math.round(o.totalAmount / 100),
      perPaxUSD: Math.round(o.perPassengerAmount / 100),
      cabin: o.slices[0]?.cabin ?? "",
      legs: o.slices.map((s) => ({
        from: s.origin,
        to: s.destination,
        depart: s.departing,
        arrive: s.arriving,
        durationMin: s.durationMinutes,
        stops: s.stops,
      })),
    })),
  });
}

async function executeHotelSearch(input: unknown): Promise<string> {
  const parsed = input as Partial<HotelSearchInput> | null;
  if (
    !parsed ||
    typeof parsed.checkIn !== "string" ||
    typeof parsed.checkOut !== "string" ||
    typeof parsed.rooms !== "number" ||
    typeof parsed.adults !== "number"
  ) {
    return JSON.stringify({
      error: "invalid input — need checkIn, checkOut, rooms, adults",
    });
  }
  if (
    !parsed.destinationCode &&
    (typeof parsed.latitude !== "number" ||
      typeof parsed.longitude !== "number")
  ) {
    return JSON.stringify({
      error:
        "either destinationCode OR (latitude + longitude) is required",
    });
  }

  const result = await searchHotels({
    destinationCode: parsed.destinationCode,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    radiusKm: parsed.radiusKm,
    checkIn: parsed.checkIn,
    checkOut: parsed.checkOut,
    rooms: parsed.rooms,
    adults: parsed.adults,
    children: parsed.children,
    maxResults: 8,
  });

  if (!result.ok) return JSON.stringify({ error: result.error });

  return JSON.stringify({
    hotelCount: result.hotels.length,
    hotels: result.hotels.map((h) => ({
      hotelCode: h.hotelCode,
      summary: formatHotelOneLine(h),
      name: h.name,
      category: h.categoryName,
      zone: h.zoneName,
      destination: h.destinationName,
      currency: h.currency,
      totalUSD: Math.round(h.minTotalAmount / 100),
      perNightPerRoomUSD: Math.round(h.perNightPerRoomAmount / 100),
      refundable: h.refundable,
      sampleRooms: h.rooms.map((r) => ({
        name: r.name,
        rateType: r.rateType,
        totalUSD: Math.round(r.totalAmount / 100),
        board: r.boardName,
      })),
    })),
  });
}

async function executeBookFlight(
  input: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) {
    return JSON.stringify({
      error: "book_flight requires trip context — internal wiring issue.",
    });
  }
  const parsed = input as Partial<BookFlightInput> | null;
  if (
    !parsed ||
    typeof parsed.offerId !== "string" ||
    !Array.isArray(parsed.passengers) ||
    parsed.passengers.length === 0
  ) {
    return JSON.stringify({
      error: "invalid input — need offerId and passengers[]",
    });
  }
  for (const p of parsed.passengers) {
    if (
      !p ||
      typeof p.given_name !== "string" ||
      typeof p.family_name !== "string" ||
      typeof p.born_on !== "string" ||
      (p.gender !== "m" && p.gender !== "f") ||
      typeof p.email !== "string" ||
      typeof p.phone_number !== "string"
    ) {
      return JSON.stringify({
        error:
          "each passenger needs given_name, family_name, born_on (YYYY-MM-DD), gender (m/f), email, phone_number (E.164).",
      });
    }
  }

  const result = await bookFlightOffer({
    offerId: parsed.offerId,
    passengers: parsed.passengers,
  });

  if (!result.ok) {
    return JSON.stringify({ error: result.error });
  }

  try {
    await recordFlightBooking({
      tripId: ctx.tripId,
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
    return JSON.stringify({
      ok: true,
      bookingReference: result.bookingReference,
      airline: result.airline,
      totalUSD: Math.round(result.totalAmount / 100),
      slicesSummary: result.slicesSummary,
      warning:
        "Ticketed at Duffel but couldn't persist to the trip itinerary: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  return JSON.stringify({
    ok: true,
    bookingReference: result.bookingReference,
    airline: result.airline,
    passengers: result.passengers,
    totalUSD: Math.round(result.totalAmount / 100),
    currency: result.currency,
    slicesSummary: result.slicesSummary,
    isSandbox: result.isSandbox,
    note: result.isSandbox
      ? "Saved to trip itinerary. This is a Duffel sandbox booking — surface the confirmation honestly but note real airline verification activates with a live key."
      : "Saved to trip itinerary. Surface the booking reference to the user.",
  });
}

async function executeBookHotel(
  input: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) {
    return JSON.stringify({ error: "book_hotel requires trip context" });
  }
  const parsed = input as Partial<BookHotelInput> | null;
  if (
    !parsed ||
    typeof parsed.rateKey !== "string" ||
    typeof parsed.hotelName !== "string" ||
    typeof parsed.checkIn !== "string" ||
    typeof parsed.checkOut !== "string" ||
    typeof parsed.rooms !== "number" ||
    !Array.isArray(parsed.guests) ||
    typeof parsed.holderName !== "string" ||
    typeof parsed.holderSurname !== "string" ||
    typeof parsed.holderEmail !== "string"
  ) {
    return JSON.stringify({
      error:
        "invalid input — need rateKey, hotelName, checkIn, checkOut, rooms, guests[], holderName, holderSurname, holderEmail",
    });
  }

  const result = await bookHotel({
    rateKey: parsed.rateKey,
    hotelName: parsed.hotelName,
    city: parsed.city ?? null,
    checkIn: parsed.checkIn,
    checkOut: parsed.checkOut,
    rooms: parsed.rooms,
    guests: parsed.guests,
    holderName: parsed.holderName,
    holderSurname: parsed.holderSurname,
    holderEmail: parsed.holderEmail,
  });

  if (!result.ok) return JSON.stringify({ error: result.error });

  try {
    await recordHotelBooking({
      tripId: ctx.tripId,
      bookingReference: result.bookingReference,
      providerReference: result.providerReference,
      totalAmount: result.totalAmount,
      currency: result.currency,
      hotelName: result.hotelName,
      city: parsed.city ?? null,
      checkIn: parsed.checkIn,
      checkOut: parsed.checkOut,
      rooms: parsed.rooms,
      guests: parsed.guests.length,
      isStub: result.isStub,
    });
  } catch (err) {
    return JSON.stringify({
      ok: true,
      isStub: result.isStub,
      bookingReference: result.bookingReference,
      hotelName: result.hotelName,
      totalUSD: Math.round(result.totalAmount / 100),
      warning:
        "Booked at Hotelbeds but couldn't persist to the trip itinerary: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  return JSON.stringify({
    ok: true,
    isStub: result.isStub,
    bookingReference: result.bookingReference,
    hotelName: result.hotelName,
    totalUSD: Math.round(result.totalAmount / 100),
    currency: result.currency,
    note: result.isStub
      ? "STUB booking — tell the user this is pencilled in until partner API access lands."
      : "Saved to trip itinerary.",
  });
}

async function executeBookTeeTime(
  input: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) {
    return JSON.stringify({ error: "book_tee_time requires trip context" });
  }
  const parsed = input as Partial<BookTeeTimeInput> | null;
  if (
    !parsed ||
    typeof parsed.courseName !== "string" ||
    typeof parsed.teeOffISO !== "string" ||
    typeof parsed.players !== "number" ||
    typeof parsed.greenFeePerPlayer !== "number" ||
    typeof parsed.leadPlayerName !== "string" ||
    typeof parsed.leadPlayerEmail !== "string"
  ) {
    return JSON.stringify({
      error:
        "invalid input — need courseName, teeOffISO, players, greenFeePerPlayer (cents), leadPlayerName, leadPlayerEmail",
    });
  }

  const result = await bookTeeTime({
    courseName: parsed.courseName,
    teeOffISO: parsed.teeOffISO,
    players: parsed.players,
    greenFeePerPlayer: parsed.greenFeePerPlayer,
    leadPlayerName: parsed.leadPlayerName,
    leadPlayerEmail: parsed.leadPlayerEmail,
  });

  if (!result.ok) return JSON.stringify({ error: result.error });

  try {
    await recordTeeTimeBooking({
      tripId: ctx.tripId,
      bookingReference: result.bookingReference,
      providerReference: result.providerReference,
      totalAmount: result.totalAmount,
      currency: result.currency,
      courseName: result.courseName,
      teeOffISO: parsed.teeOffISO,
      players: parsed.players,
      isStub: result.isStub,
    });
  } catch (err) {
    return JSON.stringify({
      ok: true,
      isStub: result.isStub,
      bookingReference: result.bookingReference,
      courseName: result.courseName,
      totalUSD: Math.round(result.totalAmount / 100),
      warning:
        "Booked at provider but couldn't persist to the trip itinerary: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  return JSON.stringify({
    ok: true,
    isStub: result.isStub,
    bookingReference: result.bookingReference,
    courseName: result.courseName,
    players: parsed.players,
    totalUSD: Math.round(result.totalAmount / 100),
    currency: result.currency,
    note: result.isStub
      ? "STUB booking — tell the user the tee time is pencilled in until Lightspeed Golf API access lands."
      : "Saved to trip itinerary.",
  });
}

async function executeBookRestaurant(
  input: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) {
    return JSON.stringify({ error: "book_restaurant requires trip context" });
  }
  const parsed = input as Partial<BookRestaurantInput> | null;
  if (
    !parsed ||
    typeof parsed.restaurantName !== "string" ||
    typeof parsed.city !== "string" ||
    typeof parsed.dateTimeISO !== "string" ||
    typeof parsed.partySize !== "number" ||
    typeof parsed.contactName !== "string" ||
    typeof parsed.contactPhone !== "string" ||
    typeof parsed.contactEmail !== "string"
  ) {
    return JSON.stringify({
      error:
        "invalid input — need restaurantName, city, dateTimeISO, partySize, contactName, contactPhone, contactEmail",
    });
  }

  const result = await bookRestaurant({
    restaurantName: parsed.restaurantName,
    city: parsed.city,
    dateTimeISO: parsed.dateTimeISO,
    partySize: parsed.partySize,
    contactName: parsed.contactName,
    contactPhone: parsed.contactPhone,
    contactEmail: parsed.contactEmail,
  });

  if (!result.ok) {
    if ("fallback" in result && result.fallback === "link") {
      return JSON.stringify({
        ok: false,
        fallback: "link",
        restaurantName: result.restaurantName,
        reservationUrl: result.reservationUrl,
        reason: result.reason,
        note: "Tell the user honestly that you couldn't book directly — quote the link.",
      });
    }
    return JSON.stringify({
      error: "error" in result ? result.error : "Restaurant booking failed.",
    });
  }

  try {
    await recordRestaurantBooking({
      tripId: ctx.tripId,
      bookingReference: result.bookingReference,
      providerReference: result.providerReference,
      restaurantName: result.restaurantName,
      city: parsed.city,
      dateTimeISO: parsed.dateTimeISO,
      partySize: parsed.partySize,
      isStub: result.isStub,
    });
  } catch (err) {
    return JSON.stringify({
      ok: true,
      isStub: result.isStub,
      bookingReference: result.bookingReference,
      restaurantName: result.restaurantName,
      warning:
        "Reserved but couldn't persist to the trip itinerary: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  return JSON.stringify({
    ok: true,
    isStub: result.isStub,
    bookingReference: result.bookingReference,
    restaurantName: result.restaurantName,
    partySize: parsed.partySize,
    dateTimeISO: parsed.dateTimeISO,
    note: "Saved to trip itinerary.",
  });
}

async function executeBookCar(
  input: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) {
    return JSON.stringify({ error: "book_car requires trip context" });
  }
  const parsed = input as Partial<BookCarInput> | null;
  if (
    !parsed ||
    typeof parsed.pickupAirport !== "string" ||
    typeof parsed.pickupISO !== "string" ||
    typeof parsed.returnISO !== "string" ||
    typeof parsed.carClass !== "string" ||
    typeof parsed.driverName !== "string" ||
    typeof parsed.driverEmail !== "string"
  ) {
    return JSON.stringify({
      error:
        "invalid input — need pickupAirport, pickupISO, returnISO, carClass, driverName, driverEmail",
    });
  }

  const result = await bookCar({
    pickupAirport: parsed.pickupAirport,
    pickupISO: parsed.pickupISO,
    returnISO: parsed.returnISO,
    carClass: parsed.carClass,
    driverName: parsed.driverName,
    driverEmail: parsed.driverEmail,
  });

  if (!result.ok) return JSON.stringify({ error: result.error });

  try {
    await recordCarBooking({
      tripId: ctx.tripId,
      bookingReference: result.bookingReference,
      providerReference: result.providerReference,
      totalAmount: result.totalAmount,
      currency: result.currency,
      vendor: result.vendor,
      carClass: result.carClass,
      pickupAirport: parsed.pickupAirport,
      pickupISO: parsed.pickupISO,
      returnISO: parsed.returnISO,
      isStub: result.isStub,
    });
  } catch (err) {
    return JSON.stringify({
      ok: true,
      isStub: result.isStub,
      bookingReference: result.bookingReference,
      vendor: result.vendor,
      totalUSD: Math.round(result.totalAmount / 100),
      warning:
        "Reserved at provider but couldn't persist to the trip itinerary: " +
        (err instanceof Error ? err.message : String(err)),
    });
  }

  return JSON.stringify({
    ok: true,
    isStub: result.isStub,
    bookingReference: result.bookingReference,
    vendor: result.vendor,
    carClass: result.carClass,
    totalUSD: Math.round(result.totalAmount / 100),
    currency: result.currency,
    note: result.isStub
      ? "STUB booking — tell the user honestly this is pencilled in until Avis API access lands."
      : "Saved to trip itinerary.",
  });
}


type ProfileFields = {
  legalGivenName?: string;
  legalFamilyName?: string;
  dateOfBirth?: string;
  gender?: string;
  phone?: string;
};

function buildProfileData(input: ProfileFields) {
  const data: Record<string, unknown> = {};
  if (typeof input.legalGivenName === "string" && input.legalGivenName.trim()) {
    data.legalGivenName = input.legalGivenName.trim();
  }
  if (typeof input.legalFamilyName === "string" && input.legalFamilyName.trim()) {
    data.legalFamilyName = input.legalFamilyName.trim();
  }
  if (typeof input.dateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) {
    data.dateOfBirth = new Date(input.dateOfBirth + "T00:00:00Z");
  }
  if (input.gender === "m" || input.gender === "f") {
    data.gender = input.gender;
  }
  if (typeof input.phone === "string" && /^\+?\d{7,}$/.test(input.phone.replace(/\s/g, ""))) {
    data.phone = input.phone.replace(/\s/g, "");
  }
  return data;
}

async function executeSaveUserProfile(
  rawInput: unknown,
  ctx: { userId?: string },
): Promise<string> {
  if (!ctx.userId) {
    return JSON.stringify({ error: "no user id in context" });
  }
  const input = (rawInput ?? {}) as ProfileFields;
  const data = buildProfileData(input);
  if (Object.keys(data).length === 0) {
    return JSON.stringify({ ok: false, note: "no valid fields supplied" });
  }
  try {
    const updated = await db.user.update({
      where: { id: ctx.userId },
      data,
      select: {
        legalGivenName: true,
        legalFamilyName: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
      },
    });
    return JSON.stringify({
      ok: true,
      saved: Object.keys(data),
      profile: {
        legalGivenName: updated.legalGivenName,
        legalFamilyName: updated.legalFamilyName,
        dateOfBirth: updated.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        gender: updated.gender,
        phone: updated.phone,
      },
      note: "Saved to user profile — will auto-fill future bookings without re-asking.",
    });
  } catch (err) {
    return JSON.stringify({
      error: "save failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function executeSaveMemberProfile(
  rawInput: unknown,
  ctx: { tripId?: string },
): Promise<string> {
  if (!ctx.tripId) return JSON.stringify({ error: "no trip id in context" });
  const input = (rawInput ?? {}) as ProfileFields & { email?: string };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email) return JSON.stringify({ error: "email is required to identify the member" });
  const data = buildProfileData(input);
  if (Object.keys(data).length === 0) {
    return JSON.stringify({ ok: false, note: "no valid fields supplied" });
  }
  try {
    const member = await db.tripMember.findUnique({
      where: { tripId_email: { tripId: ctx.tripId, email } },
      select: { id: true },
    });
    if (!member) {
      return JSON.stringify({
        error: "no member with that email on this trip",
        hint: "Invite them first, or confirm the email spelling.",
      });
    }
    await db.tripMember.update({ where: { id: member.id }, data });
    return JSON.stringify({
      ok: true,
      saved: Object.keys(data),
      note: `Saved profile for ${email} on this trip.`,
    });
  } catch (err) {
    return JSON.stringify({
      error: "save failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

