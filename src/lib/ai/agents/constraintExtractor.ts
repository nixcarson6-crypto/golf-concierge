import { runStructured, type AgentMessage, withAgentRun } from "../orchestrator";
import { CONSTRAINT_EXTRACTOR_SYSTEM } from "../prompts";
import { extractionResponseSchema, type ExtractionResponse, type TripConstraints } from "../schemas";
import { DESTINATIONS } from "@/lib/data/destinations";
import { db } from "@/lib/db";

export type ConstraintExtractorInput = {
  tripId: string;
  /** Latest constraints we already know about the trip. */
  current: TripConstraints;
  /** Recent chat turns including the new user message at the end. */
  messages: AgentMessage[];
};

const CONTEXT_TURNS = 12;

export async function runConstraintExtractor(input: ConstraintExtractorInput) {
  return withAgentRun({
    tripId: input.tripId,
    agentType: "CONSTRAINT_EXTRACTOR",
    input: { current: input.current as Record<string, unknown> },
    progress: "Listening…",
    fn: async () => {
      // Skip any leading assistant turns so the trailing slice starts with a
      // user role — keeps consecutive messages alternating after the seed
      // user/assistant pair we prepend below (Anthropic rejects two assistant
      // messages in a row).
      const firstUserIdx = input.messages.findIndex((m) => m.role === "user");
      const fromFirstUser =
        firstUserIdx === -1 ? [] : input.messages.slice(firstUserIdx);
      const recent = fromFirstUser.slice(-CONTEXT_TURNS);

      const marketCues = DESTINATIONS.map(
        (d) => `- ${d.name} (slug: ${d.slug}) — golf ${d.golfScore}, nightlife ${d.nightlifeScore}, logistics ${d.logisticsScore}`,
      ).join("\n");

      // Cross-trip memory: pull a one-line summary of this owner's most
      // recent completed or booked trips so they don't have to re-describe
      // their group's preferences from scratch.
      const trip = await db.trip.findUnique({
        where: { id: input.tripId },
        select: { ownerId: true },
      });
      let priorTripsSection = "";
      if (trip) {
        const priors = await db.trip.findMany({
          where: {
            ownerId: trip.ownerId,
            id: { not: input.tripId },
            status: { in: ["BOOKED", "COMPLETED"] },
          },
          orderBy: { updatedAt: "desc" },
          take: 3,
          include: { summary: true },
        });
        if (priors.length > 0) {
          const lines = priors.map(
            (t) =>
              `- ${t.destination ?? t.title} for ${t.groupSize ?? "?"} players · ${
                t.summary?.content?.slice(0, 200).replace(/\s+/g, " ").trim() ??
                "no summary"
              }`,
          );
          priorTripsSection = `\nPRIOR TRIPS BY THIS OWNER (use as taste hints, don't reference unsolicited):\n${lines.join("\n")}\n`;
        }
      }

      const seed: AgentMessage[] = [
        {
          role: "user",
          content: [
            `MARKETS YOU CAN CONFIDENTLY PLAN (have full curated knowledge for):`,
            marketCues,
            `For any other destination, you can still plan but should signal uncertainty.`,
            priorTripsSection,
            `Current known constraints (JSON):`,
            JSON.stringify(input.current, null, 2),
            ``,
            `Update them based on the conversation that follows. If a field has no signal, return null for it.`,
          ].join("\n"),
        },
        { role: "assistant", content: "Understood. Continuing the conversation." },
        ...recent,
      ];

      const result: ExtractionResponse = await runStructured({
        tier: "orchestrator",
        system: CONSTRAINT_EXTRACTOR_SYSTEM,
        cacheSystem: true,
        schema: extractionResponseSchema,
        toolName: "update_trip_state",
        toolDescription:
          "Echo back ALL known constraints, the concierge reply, any follow-up questions, and whether you're ready to plan.",
        messages: seed,
        maxTokens: 2048,
        temperature: 0.4,
      });

      return result;
    },
  });
}
