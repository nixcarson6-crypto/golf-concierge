/**
 * Context-aware chat suggestions. A small Haiku call returns three short,
 * relevant next-step prompts based on the trip's current state. Replaces
 * the static SUGGESTIONS_* arrays that suggested "Plan Scottsdale for 8"
 * to people planning Italy.
 */

import { anthropic, modelFor } from "../client";

export type SuggestionInput = {
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  groupSize: number | null;
  hasItinerary: boolean;
  hasBookedFlight: boolean;
  hasBookedHotel: boolean;
  hasBookedTeeTime: boolean;
  hasBookedCar: boolean;
  hasBookedRestaurant: boolean;
  lastAssistantMessage: string | null;
};

const SYSTEM = `You write 3 short, context-aware next-step suggestions for a user
planning a luxury golf trip with an AI concierge. Each ≤60 characters.

Hard rules:
- The suggestions MUST reflect the current trip state. If destination is
  "Italy", never suggest Scottsdale. If a flight is already booked, do NOT
  suggest finding flights again.
- Action-oriented, written from the user's POV ("Book the Pebble round",
  "Add Wednesday tee time", "Find a steakhouse for arrival night").
- Concierge voice: warm, brief, confident, no exclamation marks, no filler.
- Each suggestion stands alone — no numbering or bullet characters.

Output STRICTLY this JSON shape, nothing else:
{"suggestions":["<≤60 chars>","<≤60 chars>","<≤60 chars>"]}`;

export type SuggestionResult = { suggestions: string[] };

export async function generateSuggestions(
  input: SuggestionInput,
): Promise<SuggestionResult> {
  const client = anthropic();

  const state = [
    `Destination: ${input.destination ?? "TBD"}`,
    `Dates: ${input.startDate ?? "TBD"} → ${input.endDate ?? "TBD"}`,
    `Group size: ${input.groupSize ?? "TBD"}`,
    `Has itinerary: ${input.hasItinerary}`,
    `Booked flight: ${input.hasBookedFlight}`,
    `Booked hotel: ${input.hasBookedHotel}`,
    `Booked tee time: ${input.hasBookedTeeTime}`,
    `Booked car rental: ${input.hasBookedCar}`,
    `Booked restaurant: ${input.hasBookedRestaurant}`,
    input.lastAssistantMessage
      ? `Last concierge message: "${input.lastAssistantMessage.slice(0, 240).replace(/\s+/g, " ")}"`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userMsg = `Trip state:\n${state}\n\nReturn 3 next-step suggestions as JSON.`;

  const res = await client.messages.create({
    model: modelFor("fast"),
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: "user", content: userMsg }],
  });

  // Extract first text block + parse JSON
  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

  // Tolerate the model wrapping JSON in code fences
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return { suggestions: [] };
  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      suggestions?: unknown;
    };
    const arr = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return {
      suggestions: arr
        .filter((s): s is string => typeof s === "string")
        .slice(0, 3)
        .map((s) => s.replace(/^[-*•\d.]+\s*/, "").trim())
        .filter((s) => s.length > 0 && s.length <= 80),
    };
  } catch {
    return { suggestions: [] };
  }
}
