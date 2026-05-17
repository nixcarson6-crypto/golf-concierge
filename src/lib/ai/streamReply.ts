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
  history: Array<{ role: "user" | "assistant"; content: string }>;
  cacheSystem?: boolean;
  maxTokens?: number;
};

/** Anthropic-hosted web search. Server-side execution; no client executor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WEB_SEARCH_TOOL: any = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
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
        description: "Cabin class. Default economy if not specified.",
      },
    },
    required: ["slices", "passengers"],
  },
};

const HOTEL_TOOL: Anthropic.Tool = {
  name: "search_hotels",
  description:
    "Search live hotel availability and rates via Hotelbeds. Use this whenever the user asks for hotel prices, availability, or wants you to book lodging. Geolocation-based: you provide lat/lng of the target area and a radius. You know coordinates for major destinations (Colorado Springs: 38.83/-104.82, Scottsdale: 33.50/-111.92, Pinehurst: 35.19/-79.47, etc.). Default radius 20km works for most cities. Returns hotels sorted cheapest first with category (stars), per-night/per-room rate, total stay cost, board (breakfast/etc.), and refundability. Use this INSTEAD OF web_search when the user wants bookable hotel rates. Use web_search only for things Hotelbeds doesn't have: dress codes, course details, hotel amenities not in the API response.",
  input_schema: {
    type: "object",
    properties: {
      latitude: {
        type: "number",
        description: "Latitude of search center (decimal degrees, e.g. 38.8339).",
      },
      longitude: {
        type: "number",
        description: "Longitude of search center (decimal degrees, e.g. -104.8214).",
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
    required: ["latitude", "longitude", "checkIn", "checkOut", "rooms", "adults"],
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
      tools: [FLIGHT_TOOL, HOTEL_TOOL, WEB_SEARCH_TOOL] as Anthropic.Tool[],
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
      const result = await executeTool(block.name, block.input);
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

async function executeTool(name: string, input: unknown): Promise<string> {
  if (name === "search_hotels") return executeHotelSearch(input);
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
    typeof parsed.latitude !== "number" ||
    typeof parsed.longitude !== "number" ||
    typeof parsed.checkIn !== "string" ||
    typeof parsed.checkOut !== "string" ||
    typeof parsed.rooms !== "number" ||
    typeof parsed.adults !== "number"
  ) {
    return JSON.stringify({
      error:
        "invalid input — need latitude, longitude, checkIn, checkOut, rooms, adults",
    });
  }

  const result = await searchHotels({
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
