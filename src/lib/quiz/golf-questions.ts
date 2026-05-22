/**
 * Quiz schema — question types + the actual golf-travel question set.
 *
 * Replaces the chat-based intake with a Hungry Root-style multi-step
 * questionnaire. Answers map directly onto TripConstraints so the
 * existing destination + itinerary agents can run on them without any
 * LLM-side constraint extraction. Saves ~70-80% of per-trip API cost
 * vs the chat flow.
 *
 * Smart skipping: every question can declare a `shouldShow` predicate
 * so we don't ask the user something they've already answered another
 * way (e.g. once they've typed "Pinehurst" we skip course-style /
 * difficulty / lodging-tier — Pinehurst already implies all of those).
 *
 * Universal free-text escape hatch: every single-select and multi-select
 * question can declare a `freeTextField` so the user can type a
 * response when none of the options fit. The text writes into a
 * companion answer key that the build endpoint can read.
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
      /**
       * Optional free-text input below the cards — for things the
       * preset options don't cover. The text writes into `writesTo`
       * (separate from the multi-select array itself).
       */
      freeTextField?: {
        writesTo: string;
        label: string;
        placeholder?: string;
      };
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
/* Shared predicates                                                           */
/* -------------------------------------------------------------------------- */

const hasSpecificDestination = (a: QuizAnswers): boolean =>
  typeof a.destination === "string" && (a.destination as string).trim().length > 0;

const hasFullDateRange = (a: QuizAnswers): boolean => {
  const d = a.dates as { start?: string; end?: string } | undefined;
  return Boolean(d?.start && d?.end);
};

const isSolo = (a: QuizAnswers): boolean => {
  // Solo if they picked "Just me" OR typed an exact number 1 in the
  // free-text override. Without checking the custom path we'd ask
  // "Who's going?" to someone who already said they're alone.
  if (a.groupSize === "1") return true;
  if (a.groupSize === "custom") {
    const n = parseInt((a.groupSizeCustom as string | undefined) ?? "", 10);
    if (n === 1) return true;
  }
  return false;
};

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
    freeTextField: {
      writesTo: "groupSizeCustom",
      selectsValue: "custom",
      label: "Or type an exact number",
      placeholder: "e.g. 3",
    },
  },
  {
    kind: "single-select",
    id: "who",
    sectionId: "trip",
    title: "Who's going?",
    subtitle: "Helps us tune the vibe.",
    options: [
      { value: "buddies", label: "Buddies trip", glyph: "🍺" },
      { value: "couple", label: "With my partner", glyph: "💞" },
      { value: "family", label: "Family", glyph: "👨‍👩‍👧" },
      { value: "business", label: "Business / clients", glyph: "💼" },
      { value: "mixed", label: "Mixed crew", glyph: "🎭" },
    ],
    freeTextField: {
      writesTo: "whoCustom",
      selectsValue: "custom",
      label: "Or describe in your own words",
      placeholder: "e.g. college roommates reunion",
    },
    shouldShow: (a) => !isSolo(a),
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
    // Skip if the user already gave us both depart + return dates —
    // length is implicit from those.
    shouldShow: (a) => !hasFullDateRange(a),
  },
  {
    kind: "single-select",
    id: "originAirport",
    sectionId: "trip",
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
    freeTextField: {
      writesTo: "courseStyleNotes",
      label: "Anything else about the course style?",
      placeholder: "e.g. water hazards, dramatic elevation, walking-friendly",
    },
    // Skip when the user already named a destination — the courses
    // there are what they are.
    shouldShow: (a) => !hasSpecificDestination(a),
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
    shouldShow: (a) => !hasSpecificDestination(a),
  },
  {
    kind: "single-select",
    id: "airlinePreference",
    sectionId: "vibe",
    title: "Airline preference?",
    subtitle: "We'll prefer this carrier when fares are competitive.",
    options: [
      { value: "best_rate", label: "Best rate — I don't care", description: "Cheapest reasonable", glyph: "💰" },
      { value: "AA", label: "American", glyph: "🅰️" },
      { value: "DL", label: "Delta", glyph: "🔺" },
      { value: "UA", label: "United", glyph: "🔵" },
      { value: "WN", label: "Southwest", glyph: "💛" },
      { value: "AS", label: "Alaska", glyph: "🐻" },
      { value: "B6", label: "JetBlue", glyph: "🟦" },
    ],
    freeTextField: {
      writesTo: "airlinePreferenceCustom",
      selectsValue: "custom",
      label: "Or type the airline you prefer",
      placeholder: "e.g. Hawaiian, Frontier, Spirit",
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
    // If the user already said "Best rate — I don't care" on the
    // airline question, asking what cabin they want is exactly the
    // question they just refused to answer. Skip — we default to
    // economy at submit time (see quizAnswersToConstraints).
    shouldShow: (a) => a.airlinePreference !== "best_rate",
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
    freeTextField: {
      writesTo: "lodgingNotes",
      selectsValue: "custom",
      label: "Or name the property you want",
      placeholder: "e.g. The Carolina at Pinehurst, The Lodge at Bandon",
    },
    // Skip when the user already named a destination — most named
    // golf destinations have an implied flagship property.
    shouldShow: (a) => !hasSpecificDestination(a),
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
    freeTextField: {
      writesTo: "vibeCustom",
      selectsValue: "custom",
      label: "Or describe in your own words",
      placeholder: "e.g. quiet during the day, lively after dinner",
    },
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
    freeTextField: {
      writesTo: "diningNotes",
      label: "Anything specific — restaurants, cuisines, allergies?",
      placeholder: "e.g. shellfish allergy, must include sushi night",
    },
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
    freeTextField: {
      writesTo: "activitiesNotes",
      label: "Or anything else you'd want to do",
      placeholder: "e.g. clay shooting, distillery tour, wine tasting",
    },
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
    freeTextField: {
      writesTo: "transportCustom",
      selectsValue: "custom",
      label: "Or specify (e.g. limo, helicopter transfer)",
      placeholder: "e.g. helicopter from JFK to East Hampton",
    },
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
  // Group size: prefer the custom-typed value if "custom" was chosen.
  let groupSize: number | null = null;
  if (answers.groupSize === "custom" && answers.groupSizeCustom) {
    const n = parseInt(answers.groupSizeCustom as string, 10);
    if (!Number.isNaN(n) && n > 0) groupSize = n;
  } else if (answers.groupSize) {
    groupSize = parseInt(answers.groupSize as string, 10);
  }

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

  // Aggregate freeform notes — everything we don't have a structured
  // home for AND every free-text fallback the user filled in. The
  // itinerary agent reads these.
  const noteFragments: string[] = [];
  const pushIf = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      noteFragments.push(`${label}: ${value.trim()}`);
    } else if (Array.isArray(value) && value.length > 0) {
      noteFragments.push(`${label}: ${value.join(", ")}`);
    }
  };
  if (answers.who && answers.who !== "solo" && answers.who !== "custom") {
    pushIf("Group type", answers.who);
  }
  pushIf("Group type (custom)", answers.whoCustom);
  if (answers.tripLength) pushIf("Length preference", answers.tripLength);
  if (answers.destinationMode) pushIf("Destination mode", answers.destinationMode);
  pushIf("Course style", answers.courseStyle);
  pushIf("Course style notes", answers.courseStyleNotes);
  if (answers.difficulty) pushIf("Difficulty", answers.difficulty);
  if (answers.cabinClass) pushIf("Cabin class", answers.cabinClass);
  if (answers.airlinePreference && answers.airlinePreference !== "best_rate") {
    pushIf("Airline preference", answers.airlinePreference);
  }
  pushIf("Airline preference (custom)", answers.airlinePreferenceCustom);
  if (lodging && lodging !== "custom") pushIf("Lodging tier", lodging);
  pushIf("Lodging notes", answers.lodgingNotes);
  if (vibe && vibe !== "custom") pushIf("Energy", vibe);
  pushIf("Energy (custom)", answers.vibeCustom);
  pushIf("Dining", answers.dining);
  pushIf("Dining notes", answers.diningNotes);
  pushIf("Activities", answers.activities);
  pushIf("Activities notes", answers.activitiesNotes);
  if (answers.transport && answers.transport !== "custom") {
    pushIf("Ground transport", answers.transport);
  }
  pushIf("Ground transport (custom)", answers.transportCustom);
  pushIf("Notes", answers.notes);

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
