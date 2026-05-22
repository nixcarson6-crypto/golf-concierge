/**
 * Quiz schema — question types + the actual golf-travel question set.
 *
 * Replaces the chat-based intake with a Hungry Root-style multi-step
 * questionnaire. Answers map directly onto TripConstraints so the
 * existing destination + itinerary agents can run on them without any
 * LLM-side constraint extraction. Saves ~70-80% of per-trip API cost
 * vs the chat flow.
 */

export type QuizSection = {
  id: "trip" | "vibe" | "extras";
  label: string;
};

export const QUIZ_SECTIONS: QuizSection[] = [
  { id: "trip", label: "The trip" },
  { id: "vibe", label: "Course & vibe" },
  { id: "extras", label: "The extras" },
];

/** Option for a single- or multi-select question. */
export type QuizOption = {
  value: string;
  label: string;
  description?: string;
  /** Emoji or short symbol — keeps options visually scannable without
   *  needing photographic assets at first. Swap for real images later. */
  glyph?: string;
};

export type QuizQuestion =
  | {
      kind: "single-select";
      id: string;
      sectionId: QuizSection["id"];
      title: string;
      subtitle?: string;
      options: QuizOption[];
      /**
       * If set, render an optional text input below the option cards.
       * Filling it writes to `freeTextField.writesTo` and auto-selects
       * `freeTextField.selectsValue` on this question. Lets a single
       * screen offer "pick from these" + "or type your own".
       */
      freeTextField?: {
        writesTo: string;
        selectsValue: string;
        label: string;
        placeholder?: string;
      };
      /** If set, this question is skipped unless the predicate passes. */
      shouldShow?: (answers: QuizAnswers) => boolean;
    }
  | {
      kind: "multi-select";
      id: string;
      sectionId: QuizSection["id"];
      title: string;
      subtitle?: string;
      options: QuizOption[];
      minSelect?: number;
      maxSelect?: number;
      shouldShow?: (answers: QuizAnswers) => boolean;
    }
  | {
      kind: "slider";
      id: string;
      sectionId: QuizSection["id"];
      title: string;
      subtitle?: string;
      min: number;
      max: number;
      step: number;
      defaultValue: number;
      /** Format the displayed value, e.g. (v) => `$${v.toLocaleString()}`. */
      format?: (value: number) => string;
      shouldShow?: (answers: QuizAnswers) => boolean;
    }
  | {
      kind: "date-range";
      id: string;
      sectionId: QuizSection["id"];
      title: string;
      subtitle?: string;
      shouldShow?: (answers: QuizAnswers) => boolean;
    }
  | {
      kind: "free-text";
      id: string;
      sectionId: QuizSection["id"];
      title: string;
      subtitle?: string;
      placeholder?: string;
      optional?: boolean;
      shouldShow?: (answers: QuizAnswers) => boolean;
    };

/** Untyped bag of answers — coerced into TripConstraints at submit. */
export type QuizAnswers = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Golf travel question set                                                    */
/* -------------------------------------------------------------------------- */

export const GOLF_QUIZ: QuizQuestion[] = [
  // ── Section 1: The trip ────────────────────────────────────────────────
  {
    kind: "single-select",
    id: "groupSize",
    sectionId: "trip",
    title: "How many players?",
    subtitle: "We'll match group-friendly tee times and lodging.",
    options: [
      { value: "1", label: "Just me", glyph: "⛳" },
      { value: "2", label: "2 players", glyph: "👥" },
      { value: "4", label: "Foursome", glyph: "🏌️🏌️🏌️🏌️" },
      { value: "6", label: "5–8 players", glyph: "🍻" },
      { value: "12", label: "9+ players", glyph: "🎉" },
    ],
  },
  {
    kind: "single-select",
    id: "who",
    sectionId: "trip",
    title: "Who's going?",
    subtitle: "Helps us tune the vibe.",
    options: [
      { value: "solo", label: "Just me", glyph: "🧍" },
      { value: "buddies", label: "Buddies trip", glyph: "🍺" },
      { value: "couple", label: "With my partner", glyph: "💞" },
      { value: "family", label: "Family", glyph: "👨‍👩‍👧" },
      { value: "business", label: "Business / clients", glyph: "💼" },
      { value: "mixed", label: "Mixed crew", glyph: "🎭" },
    ],
    shouldShow: (a) => a.groupSize !== "1",
  },
  {
    kind: "date-range",
    id: "dates",
    sectionId: "trip",
    title: "When?",
    subtitle: "Specific dates if you have them, or skip and we'll suggest a window.",
  },
  {
    kind: "single-select",
    id: "tripLength",
    sectionId: "trip",
    title: "How long?",
    subtitle: "Skip if your dates above already cover it.",
    options: [
      { value: "weekend", label: "Long weekend", description: "3 nights", glyph: "📅" },
      { value: "midweek", label: "4–5 days", description: "Sweet spot", glyph: "🗓️" },
      { value: "week", label: "A full week", description: "7+ nights", glyph: "🏖️" },
      { value: "flexible", label: "Flexible", description: "Let the trip decide", glyph: "🔄" },
    ],
  },
  {
    kind: "slider",
    id: "budgetPerPerson",
    sectionId: "trip",
    title: "Budget per person?",
    subtitle: "Everything in — flights, lodging, golf, dining, transport.",
    min: 2000,
    max: 25000,
    step: 500,
    defaultValue: 8000,
    format: (v) => (v >= 25000 ? "$25k+" : `$${v.toLocaleString()}`),
  },

  // ── Section 2: The course & vibe ───────────────────────────────────────
  {
    kind: "single-select",
    id: "destinationMode",
    sectionId: "vibe",
    title: "Where?",
    subtitle: "Type a destination, or let us match one.",
    options: [
      { value: "suggest", label: "Surprise me", description: "We'll pick the strongest fit", glyph: "✨" },
      { value: "top3", label: "Show me top 3", description: "We'll rank options, you choose", glyph: "🏆" },
    ],
    freeTextField: {
      writesTo: "destination",
      selectsValue: "specific",
      label: "Or type the destination you want",
      placeholder: "e.g. Pinehurst, Scottsdale, Bandon Dunes, Vermont",
    },
  },
  {
    kind: "multi-select",
    id: "courseStyle",
    sectionId: "vibe",
    title: "Course style?",
    subtitle: "Pick everything that appeals.",
    minSelect: 1,
    options: [
      { value: "championship", label: "Championship classic", description: "Donald Ross, Tillinghast, Travis", glyph: "🏆" },
      { value: "modern_resort", label: "Modern resort", description: "Manicured, conditioned, photogenic", glyph: "🌴" },
      { value: "links", label: "Links / coastal", description: "Bandon, Streamsong vibe", glyph: "🌊" },
      { value: "mountain", label: "Mountain", description: "Equinox, Greenbrier, Broadmoor", glyph: "🏔️" },
      { value: "desert", label: "Desert", description: "Troon, Whisper Rock, Scottsdale", glyph: "🌵" },
      { value: "hidden_gem", label: "Hidden gem", description: "Off the beaten path", glyph: "💎" },
    ],
  },
  {
    kind: "single-select",
    id: "difficulty",
    sectionId: "vibe",
    title: "How tough do you want it?",
    options: [
      { value: "relaxed", label: "Relaxed", description: "Pretty enough to forgive a bad swing", glyph: "🌅" },
      { value: "fair", label: "Fair test", description: "Engaging without being punishing", glyph: "⚖️" },
      { value: "championship", label: "Championship test", description: "I want to be challenged", glyph: "🔥" },
    ],
  },
  {
    kind: "single-select",
    id: "originAirport",
    sectionId: "vibe",
    title: "Where are you flying from?",
    subtitle: "We'll search live fares from this airport.",
    options: [
      { value: "DFW", label: "Dallas/Fort Worth", description: "DFW", glyph: "✈️" },
      { value: "DAL", label: "Dallas Love", description: "DAL", glyph: "✈️" },
      { value: "ATL", label: "Atlanta", description: "ATL", glyph: "✈️" },
      { value: "ORD", label: "Chicago O'Hare", description: "ORD", glyph: "✈️" },
      { value: "LAX", label: "Los Angeles", description: "LAX", glyph: "✈️" },
      { value: "JFK", label: "New York JFK", description: "JFK", glyph: "✈️" },
      { value: "LGA", label: "New York LaGuardia", description: "LGA", glyph: "✈️" },
      { value: "EWR", label: "Newark", description: "EWR", glyph: "✈️" },
      { value: "BOS", label: "Boston", description: "BOS", glyph: "✈️" },
      { value: "MIA", label: "Miami", description: "MIA", glyph: "✈️" },
      { value: "SFO", label: "San Francisco", description: "SFO", glyph: "✈️" },
      { value: "SEA", label: "Seattle", description: "SEA", glyph: "✈️" },
    ],
    freeTextField: {
      writesTo: "originAirportCustom",
      selectsValue: "custom",
      label: "Or type a different airport (IATA code, e.g. AUS, DEN, PHX)",
      placeholder: "3-letter airport code",
    },
  },
  {
    kind: "single-select",
    id: "cabinClass",
    sectionId: "vibe",
    title: "How are we flying?",
    options: [
      { value: "first", label: "First class", glyph: "🥂" },
      { value: "business", label: "Business class", description: "Pyltrix default", glyph: "✈️" },
      { value: "premium_economy", label: "Premium economy", glyph: "💺" },
      { value: "economy", label: "Economy", glyph: "🪑" },
      { value: "best_deal", label: "Best deal", description: "Cheapest reasonable", glyph: "💰" },
    ],
  },
  {
    kind: "single-select",
    id: "lodgingTier",
    sectionId: "vibe",
    title: "Where are we staying?",
    options: [
      { value: "ultra_luxury", label: "Ultra-luxury resort", description: "Pebble, Pinehurst Carolina, The Greenbrier", glyph: "👑" },
      { value: "luxury", label: "5-star resort", description: "Top-tier name brand", glyph: "⭐" },
      { value: "boutique", label: "Boutique / character", description: "Smaller, distinctive, design-forward", glyph: "🎨" },
      { value: "premium", label: "4-star, smart-spend", description: "Comfortable, not flashy", glyph: "🛏️" },
    ],
  },
  {
    kind: "single-select",
    id: "vibe",
    sectionId: "vibe",
    title: "What's the energy?",
    options: [
      { value: "quiet", label: "Quiet retreat", description: "Spa, sunset cocktails, early to bed", glyph: "🧘" },
      { value: "lively", label: "Lively scene", description: "Restaurant nights, bars, music", glyph: "🍸" },
      { value: "bachelor", label: "Bachelor energy", description: "Send it", glyph: "🥃" },
      { value: "family", label: "Family-friendly", description: "Kid-safe, varied", glyph: "🏊" },
      { value: "business", label: "Business polish", description: "Clients-grade, formal-ready", glyph: "🤝" },
    ],
  },

  // ── Section 3: The extras ──────────────────────────────────────────────
  {
    kind: "multi-select",
    id: "dining",
    sectionId: "extras",
    title: "Dining priorities?",
    subtitle: "Pick a few — we'll plan dinners accordingly.",
    minSelect: 1,
    options: [
      { value: "steakhouse", label: "Great steakhouse", glyph: "🥩" },
      { value: "chef", label: "Chef-driven tasting", glyph: "🍽️" },
      { value: "local", label: "Casual local spots", glyph: "🍔" },
      { value: "cocktails", label: "Cocktail bars", glyph: "🍹" },
      { value: "wine", label: "Wine-focused", glyph: "🍷" },
      { value: "seafood", label: "Seafood", glyph: "🦞" },
    ],
  },
  {
    kind: "multi-select",
    id: "activities",
    sectionId: "extras",
    title: "Anything besides golf?",
    subtitle: "Optional — pick none and we'll just plan golf.",
    options: [
      { value: "spa", label: "Spa", glyph: "💆" },
      { value: "hiking", label: "Hiking", glyph: "🥾" },
      { value: "fishing", label: "Fishing", glyph: "🎣" },
      { value: "nightlife", label: "Nightlife", glyph: "🌃" },
      { value: "sightseeing", label: "Sightseeing", glyph: "📸" },
      { value: "downtime", label: "Pool/downtime", glyph: "🏖️" },
      { value: "shooting", label: "Sporting clays", glyph: "🎯" },
      { value: "shopping", label: "Shopping", glyph: "🛍️" },
    ],
  },
  {
    kind: "single-select",
    id: "transport",
    sectionId: "extras",
    title: "Ground transport?",
    options: [
      { value: "rental_luxury_suv", label: "Luxury SUV rental", description: "Pyltrix default", glyph: "🚙" },
      { value: "rental_standard", label: "Standard rental", glyph: "🚗" },
      { value: "private_driver", label: "Private driver", description: "Door-to-door, no driving", glyph: "🚘" },
      { value: "rideshare", label: "Uber / rideshare", glyph: "📱" },
    ],
  },
  {
    kind: "free-text",
    id: "notes",
    sectionId: "extras",
    title: "Anything else?",
    subtitle: "Allergies, must-play courses, dealbreakers — anything we should know.",
    placeholder: "Optional. Skip if there's nothing.",
    optional: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Map quiz answers → TripConstraints                                          */
/* -------------------------------------------------------------------------- */

import type { TripConstraints } from "@/lib/ai/schemas";

export function quizAnswersToConstraints(answers: QuizAnswers): TripConstraints {
  const groupSize = answers.groupSize ? parseInt(answers.groupSize as string, 10) : null;
  const budgetPerPerson = answers.budgetPerPerson
    ? (answers.budgetPerPerson as number)
    : null;
  const budgetTotal =
    budgetPerPerson != null && groupSize != null
      ? budgetPerPerson * groupSize
      : null;

  // Cabin/lodging → luxuryLevel
  const lodging = answers.lodgingTier as string | undefined;
  let luxuryLevel: TripConstraints["luxuryLevel"] = null;
  if (lodging === "ultra_luxury") luxuryLevel = "ULTRA_LUXURY";
  else if (lodging === "luxury" || lodging === "boutique") luxuryLevel = "LUXURY";
  else if (lodging === "premium") luxuryLevel = "PREMIUM";

  // Vibe → priorities (rough heuristic)
  const vibe = answers.vibe as string | undefined;
  let nightlifePriority: number | null = null;
  if (vibe === "quiet") nightlifePriority = 15;
  else if (vibe === "lively") nightlifePriority = 70;
  else if (vibe === "bachelor") nightlifePriority = 90;
  else if (vibe === "family") nightlifePriority = 25;
  else if (vibe === "business") nightlifePriority = 40;

  const dates = answers.dates as { start?: string; end?: string } | undefined;

  // Aggregate freeform notes from quiz answers the structured fields don't cover.
  const noteFragments: string[] = [];
  if (answers.who && answers.who !== "solo") {
    noteFragments.push(`Group type: ${answers.who}`);
  }
  if (answers.tripLength) {
    noteFragments.push(`Length preference: ${answers.tripLength}`);
  }
  if (answers.destinationMode) {
    noteFragments.push(`Destination mode: ${answers.destinationMode}`);
  }
  if (Array.isArray(answers.courseStyle) && answers.courseStyle.length) {
    noteFragments.push(`Course style: ${(answers.courseStyle as string[]).join(", ")}`);
  }
  if (answers.difficulty) {
    noteFragments.push(`Difficulty: ${answers.difficulty}`);
  }
  if (answers.cabinClass) {
    noteFragments.push(`Cabin class: ${answers.cabinClass}`);
  }
  if (lodging) {
    noteFragments.push(`Lodging tier: ${lodging}`);
  }
  if (vibe) {
    noteFragments.push(`Energy: ${vibe}`);
  }
  if (Array.isArray(answers.dining) && answers.dining.length) {
    noteFragments.push(`Dining: ${(answers.dining as string[]).join(", ")}`);
  }
  if (Array.isArray(answers.activities) && answers.activities.length) {
    noteFragments.push(`Activities: ${(answers.activities as string[]).join(", ")}`);
  }
  if (answers.transport) {
    noteFragments.push(`Ground transport: ${answers.transport}`);
  }
  if (answers.notes && (answers.notes as string).trim().length > 0) {
    noteFragments.push(`Notes: ${(answers.notes as string).trim()}`);
  }

  return {
    destination: (answers.destination as string | undefined) ?? null,
    startDate: dates?.start ?? null,
    endDate: dates?.end ?? null,
    groupSize,
    budgetTotal,
    budgetPerPerson,
    luxuryLevel,
    golfPriority: 80, // they're using a golf travel app
    nightlifePriority,
    lodgingPreference: lodging ?? null,
    transportPreference: (answers.transport as string | undefined) ?? null,
    notes: noteFragments.join(" · ") || null,
  };
}
