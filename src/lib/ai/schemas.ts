import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Trip constraints                                                            */
/* -------------------------------------------------------------------------- */

export const luxuryLevelSchema = z.enum(["PREMIUM", "LUXURY", "ULTRA_LUXURY"]);

export const tripConstraintsSchema = z.object({
  destination: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  groupSize: z.number().int().min(1).max(64).nullable().optional(),
  budgetTotal: z.number().int().min(0).nullable().optional().describe("In USD whole dollars, total trip budget"),
  budgetPerPerson: z.number().int().min(0).nullable().optional().describe("In USD whole dollars, per person"),
  luxuryLevel: luxuryLevelSchema.nullable().optional(),
  golfPriority: z.number().int().min(0).max(100).nullable().optional(),
  nightlifePriority: z.number().int().min(0).max(100).nullable().optional(),
  lodgingPreference: z.string().nullable().optional(),
  transportPreference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type TripConstraints = z.infer<typeof tripConstraintsSchema>;

export const extractionResponseSchema = z.object({
  constraints: tripConstraintsSchema,
  /** Plain-English assistant reply that should be shown in the chat. */
  reply: z.string(),
  /** Follow-up questions the concierge wants answered. */
  followUps: z.array(z.string()).max(3).default([]),
  /** Whether the concierge believes it has enough info to start planning. */
  readyToPlan: z.boolean().default(false),
});

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Destinations                                                                */
/* -------------------------------------------------------------------------- */

export const destinationOptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  golfScore: z.number().int().min(0).max(100),
  nightlifeScore: z.number().int().min(0).max(100),
  logisticsScore: z.number().int().min(0).max(100),
  weatherSummary: z.string(),
  lodgingEstimate: z.string(),
  estimatedTotalCost: z.number().int().min(0).describe("USD whole dollars"),
  estimatedPerPersonCost: z.number().int().min(0).describe("USD whole dollars"),
  aiExplanation: z.string(),
  heroImageQuery: z.string().describe("Short, specific search term we can use to fetch a hero image"),
});

export const destinationListSchema = z.object({
  options: z.array(destinationOptionSchema).min(2).max(4),
  reply: z.string(),
});

export type DestinationOptionAI = z.infer<typeof destinationOptionSchema>;
export type DestinationListAI = z.infer<typeof destinationListSchema>;

/* -------------------------------------------------------------------------- */
/* Itinerary                                                                   */
/* -------------------------------------------------------------------------- */

export const itineraryItemTypeSchema = z.enum([
  "TEE_TIME",
  "LODGING",
  "DINING",
  "NIGHTLIFE",
  "TRANSPORT",
  "FLIGHT",
  "FREE_TIME",
  "SPA",
  "ACTIVITY",
]);

export const itineraryItemSchema = z.object({
  type: itineraryItemTypeSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  startTime: z.string().nullable().optional().describe("ISO datetime"),
  endTime: z.string().nullable().optional().describe("ISO datetime"),
  cost: z.number().int().min(0).nullable().optional().describe("USD whole dollars; per-trip cost for this item (sum if multi-person)"),
  aiRationale: z.string().nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
});

export const itinerarySchema = z.object({
  summary: z.string(),
  totalCost: z.number().int().min(0).describe("USD whole dollars"),
  perPersonCost: z.number().int().min(0).describe("USD whole dollars"),
  items: z.array(itineraryItemSchema).min(1),
  /** Optional list of substitutions vs prior version */
  changes: z.array(z.string()).optional().default([]),
});

export type ItineraryAI = z.infer<typeof itinerarySchema>;
export type ItineraryItemAI = z.infer<typeof itineraryItemSchema>;

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

export const summarySchema = z.object({
  content: z.string(),
  highlights: z.array(z.string()),
  substitutions: z.array(z.string()).default([]),
});
export type SummaryAI = z.infer<typeof summarySchema>;
