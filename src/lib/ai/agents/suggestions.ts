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

const SYSTEM = `You generate 3 quick-reply chips that appear under the AI concierge's
last message. The user TAPS one and it gets SENT as their next message
to the concierge. So every chip MUST be something a customer would
actually type to their concierge — first-person, action/desire/answer
phrasing.

NEVER write a chip in the concierge's voice. NEVER write a chip that
asks the user for information. The chips are what the USER says, not
what the concierge says.

WRONG (these read like the concierge asking):
- "Tell me your preferred destination and dates"
- "Share your group size and budget"
- "What kind of vibe are you after?"
- "Describe the vibe — classic links or resort luxury?"

RIGHT (these read like the user replying):
- "Plan a 4-day trip to Scottsdale in October"
- "Pebble Beach for 6 guys, late April"
- "Surprise me — luxury, $5K/pax, anywhere in the US"
- "Book the Pebble round"
- "Swap the steakhouse for sushi"
- "Lower the hotel budget by $200/night"
- "Add a Wednesday morning tee time"

Each chip ≤ 70 characters. Three chips total. They must reflect the
current trip state — if destination is Italy, don't suggest Scottsdale;
if a flight is already booked, don't suggest finding flights.

For a brand-new trip with NO state (no destination, no dates, no group),
write three concrete starter chips the user can tap to kick off planning
— e.g. specific named destinations + dates + group size, OR a "surprise
me" with a budget signal. Never write "tell me your destination" — that
makes the user say it back to the concierge, which is nonsense.

Output STRICTLY this JSON shape, nothing else:
{"suggestions":["<≤70 chars>","<≤70 chars>","<≤70 chars>"]}`;

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
