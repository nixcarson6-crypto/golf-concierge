import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, modelFor } from "./client";
import {
  searchFlights,
  formatOfferOneLine,
  type FlightSearchInput,
} from "@/lib/bookings/providers/duffel-search";

/**
 * Streaming reply helper with tool support.
 *
 * The model may decide to call tools (currently: `search_flights`) mid-reply.
 * When it does, we pause streaming, execute the tool, append the result to
 * the conversation, and re-stream the continuation. The yielded tokens are
 * just the assistant's prose — tool-use rounds are invisible to the UI.
 */
export type StreamReplyOptions = {
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  cacheSystem?: boolean;
  maxTokens?: number;
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
      tools: [FLIGHT_TOOL],
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
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return full;
}

async function executeTool(name: string, input: unknown): Promise<string> {
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
