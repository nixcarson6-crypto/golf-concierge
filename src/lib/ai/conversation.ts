import { db } from "@/lib/db";
import type { Trip } from "@prisma/client";
import { runConstraintExtractor } from "./agents/constraintExtractor";
import { runDestinationAgent } from "./agents/destination";
import { runItineraryAgent } from "./agents/itinerary";
import type { AgentMessage } from "./orchestrator";
import type { ItineraryAI, TripConstraints } from "./schemas";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";

/**
 * Drives one turn of the concierge conversation:
 *
 *   1. Extract / refresh trip constraints from the latest user message.
 *   2. Persist the assistant's reply as a ChatMessage.
 *   3. Patch the Trip row with any newly-known constraints.
 *   4. If we're ready to plan and don't have a destination yet, fire the
 *      destination agent in parallel. If we already have a destination but no
 *      itinerary (or the user is asking us to revisit), fire the itinerary
 *      agent. These run async — the chat response returns immediately so the
 *      UI feels snappy and the agent activity panel surfaces progress.
 */
export async function processUserMessage(args: {
  trip: Trip;
  userId: string;
  text: string;
}) {
  const { trip, userId, text } = args;

  // Persist the user message first so it shows up immediately if the client
  // refetches before the agent reply lands.
  await db.chatMessage.create({
    data: { tripId: trip.id, userId, role: "USER", content: text },
  });
  nudge(trip.id);

  // Background: refresh this member's per-person preferences from their
  // accumulated messages. Lets the itinerary agent personalise per person.
  void (async () => {
    const member = await db.tripMember.findFirst({
      where: { tripId: trip.id, userId },
    });
    if (member) {
      const mod = await import("./agents/memberPreferences");
      await mod.refreshMemberPreferences({
        tripId: trip.id,
        memberId: member.id,
      });
    }
  })().catch((err) => console.error("[member prefs refresh]", err));

  // Background: compact conversation memory if the chat is getting long.
  void import("./agents/conversationSummary")
    .then((m) => m.maybeUpdateConversationSummary(trip.id))
    .catch((err) => console.error("[convo summary]", err));

  return runExtractionAndAgents({ trip, text, persistAssistantReply: true });
}

/**
 * Background variant: assumes the user message + a streamed assistant reply
 * have ALREADY been persisted, and just runs the structured constraint
 * extraction + downstream agents silently. Used by the streaming chat path.
 */
export async function processUserMessageBackground(args: {
  trip: Trip;
  userId: string;
  text: string;
  assistantTextAlreadyEmitted: string;
}) {
  return runExtractionAndAgents({
    trip: args.trip,
    text: args.text,
    persistAssistantReply: false,
  });
}

async function runExtractionAndAgents(args: {
  trip: Trip;
  text: string;
  persistAssistantReply: boolean;
}) {
  const { trip, text, persistAssistantReply } = args;

  const recent = await db.chatMessage.findMany({
    where: { tripId: trip.id },
    orderBy: { createdAt: "asc" },
    take: 30,
  });
  const messages: AgentMessage[] = recent.map((m) => ({
    role: m.role === "ASSISTANT" ? "assistant" : "user",
    content: m.content,
  }));

  const current = (trip.constraints as TripConstraints | null) ?? {};
  const { output } = await runConstraintExtractor({
    tripId: trip.id,
    current,
    messages,
  });

  const merged = mergeConstraints(current, output.constraints);

  const newTitle = autoTitle({
    currentTitle: trip.title,
    constraints: merged,
  });

  const writes = [
    db.trip.update({
      where: { id: trip.id },
      data: {
        destination: merged.destination ?? trip.destination,
        startDate: merged.startDate ? new Date(merged.startDate) : trip.startDate,
        endDate: merged.endDate ? new Date(merged.endDate) : trip.endDate,
        groupSize: merged.groupSize ?? trip.groupSize,
        budgetTotal:
          merged.budgetTotal != null ? merged.budgetTotal * 100 : trip.budgetTotal,
        budgetPerPerson:
          merged.budgetPerPerson != null
            ? merged.budgetPerPerson * 100
            : trip.budgetPerPerson,
        luxuryLevel: merged.luxuryLevel ?? trip.luxuryLevel,
        constraints: merged as object,
        status: trip.status === "DRAFT" ? "PLANNING" : trip.status,
        ...(newTitle && newTitle !== trip.title ? { title: newTitle } : {}),
      },
    }),
  ];
  if (persistAssistantReply) {
    writes.push(
      db.chatMessage.create({
        data: {
          tripId: trip.id,
          role: "ASSISTANT",
          content: output.reply,
          metadata: {
            followUps: output.followUps,
            readyToPlan: output.readyToPlan,
          },
        },
      }) as unknown as (typeof writes)[number],
    );
  }
  await db.$transaction(writes);
  nudge(trip.id);

  // Kick downstream agents in the background — don't await them so the chat
  // returns promptly. Errors are captured into AgentRun by withAgentRun().
  if (output.readyToPlan) {
    const dest = merged.destination?.trim();
    if (!dest) {
      void runDestinationAgent({ tripId: trip.id, constraints: merged }).then(
        async ({ output }) => {
          await db.destinationOption.deleteMany({ where: { tripId: trip.id } });
          await db.destinationOption.createMany({
            data: output.options.map((o, i) => ({
              tripId: trip.id,
              name: o.name,
              description: o.description,
              heroImageUrl: o.heroImageUrl,
              golfScore: o.golfScore,
              nightlifeScore: o.nightlifeScore,
              weatherSummary: o.weatherSummary,
              lodgingEstimate: o.lodgingEstimate,
              logisticsScore: o.logisticsScore,
              estimatedTotalCost: o.estimatedTotalCost * 100,
              estimatedPerPersonCost: o.estimatedPerPersonCost * 100,
              aiExplanation: o.aiExplanation,
              rank: i,
            })),
          });
          await db.chatMessage.create({
            data: {
              tripId: trip.id,
              role: "ASSISTANT",
              content: output.reply,
              metadata: { kind: "destination_options" },
            },
          });
        },
      ).catch((err) => console.error("[destination agent]", err));
    } else {
      const existing = await db.itinerary.findFirst({
        where: { tripId: trip.id, status: { in: ["CURRENT", "DRAFT"] } },
        include: { items: true },
      });
      if (!existing) {
        void buildInitialItinerary(trip.id, dest, merged).catch((err) =>
          console.error("[itinerary agent]", err),
        );
      } else if (looksLikeRefinement(text)) {
        // The user wants to tweak the existing itinerary in conversation —
        // run a refinement pass with the natural-language instruction.
        void refineItinerary(trip.id, dest, merged, text, existing).catch((err) =>
          console.error("[itinerary refine]", err),
        );
      }
    }
  }

  return {
    constraints: merged,
    reply: output.reply,
    followUps: output.followUps,
    readyToPlan: output.readyToPlan,
  };
}

async function buildInitialItinerary(
  tripId: string,
  destination: string,
  constraints: TripConstraints,
) {
  const { output } = await runItineraryAgent({
    tripId,
    destination,
    constraints,
    priorItinerary: null,
  });
  await persistItinerary(tripId, output);
}

const REFINEMENT_CUES = [
  "swap",
  "change",
  "replace",
  "instead",
  "rather",
  "different",
  "cheaper",
  "fancier",
  "earlier",
  "later",
  "less",
  "more",
  "remove",
  "drop",
  "skip",
  "add",
  "another",
  "upgrade",
  "downgrade",
  "move",
  "shift",
  "tee",
  "course",
  "hotel",
  "dinner",
  "restaurant",
  "bar",
  "nightlife",
  "flight",
];

function looksLikeRefinement(text: string) {
  const lower = text.toLowerCase();
  return REFINEMENT_CUES.some((cue) => lower.includes(cue));
}

type ExistingItinerary = Awaited<
  ReturnType<typeof db.itinerary.findFirst>
> & {
  items?: Array<{
    type: import("@prisma/client").ItineraryItemType;
    title: string;
    description: string | null;
    location: string | null;
    address: string | null;
    startTime: Date | null;
    endTime: Date | null;
    cost: number | null;
    aiRationale: string | null;
    metadata: unknown;
  }>;
};

async function refineItinerary(
  tripId: string,
  destination: string,
  constraints: TripConstraints,
  instruction: string,
  existing: ExistingItinerary,
) {
  const prior: ItineraryAI = {
    summary: existing?.aiSummary ?? "",
    totalCost: Math.round((existing?.totalCost ?? 0) / 100),
    perPersonCost: Math.round((existing?.perPersonCost ?? 0) / 100),
    items: (existing?.items ?? []).map((i) => ({
      type: i.type,
      title: i.title,
      description: i.description ?? null,
      location: i.location ?? null,
      address: i.address ?? null,
      startTime: i.startTime?.toISOString() ?? null,
      endTime: i.endTime?.toISOString() ?? null,
      cost: i.cost ? Math.round(i.cost / 100) : null,
      aiRationale: i.aiRationale ?? null,
      metadata: (i.metadata as Record<string, unknown> | null) ?? null,
    })),
    changes: [],
  };

  const { output } = await runItineraryAgent({
    tripId,
    destination,
    constraints,
    priorItinerary: prior,
    refinementInstruction: instruction,
  });
  await persistItinerary(tripId, output);
}

export async function persistItinerary(tripId: string, ai: ItineraryAI) {
  const nextVersion =
    ((
      await db.itinerary.findFirst({
        where: { tripId },
        orderBy: { version: "desc" },
        select: { version: true },
      })
    )?.version ?? 0) + 1;

  // Preserve any locked items from the previous current itinerary. If the AI
  // tried to alter them, we replace the AI's version with the locked original
  // at the same orderIndex slot so manual locks are absolutely respected.
  const previousCurrent = await db.itinerary.findFirst({
    where: { tripId, status: { in: ["CURRENT", "DRAFT"] } },
    orderBy: { version: "desc" },
    include: { items: { orderBy: { orderIndex: "asc" } } },
  });
  const lockedTitles = new Set(
    (previousCurrent?.items ?? [])
      .filter(
        (i) => (i.metadata as { locked?: boolean } | null)?.locked === true,
      )
      .map((i) => i.title.toLowerCase()),
  );

  const tripOwner = await db.trip.findUnique({ where: { id: tripId }, select: { ownerId: true } });

  return db.$transaction(async (tx) => {
    await tx.itinerary.updateMany({
      where: { tripId, status: "CURRENT" },
      data: { status: "SUPERSEDED" },
    });

    // Strip AI-fabricated prices off items where the cost is genuinely
    // unknowable up-front — dinner depends on what the customer orders,
    // a spa session might add upcharges, "free time / activity / night-
    // life" by definition has no fixed price. We keep costs only for
    // items with a real lookup-able rate: flights (Duffel), lodging
    // (room rate × nights), tee times (green fee × players), and
    // ground transport (rental day rate). Saves customers from
    // sticker-shock numbers we have no way to actually quote.
    const PRICEABLE = new Set(["FLIGHT", "LODGING", "TEE_TIME", "TRANSPORT"]);
    const cleanItems = ai.items.map((i) => ({
      ...i,
      cost: PRICEABLE.has(i.type) ? i.cost : null,
    }));
    const recomputedTotal = cleanItems.reduce(
      (sum, i) => sum + (i.cost ?? 0),
      0,
    );
    // perPerson sticks to the relationship the AI implied (perPerson =
    // total / groupSize) so the workspace stays consistent.
    const groupSizeForCalc =
      ai.totalCost > 0 && ai.perPersonCost > 0
        ? Math.max(1, Math.round(ai.totalCost / ai.perPersonCost))
        : 1;
    const recomputedPerPerson = Math.round(
      recomputedTotal / groupSizeForCalc,
    );

    const it = await tx.itinerary.create({
      data: {
        tripId,
        version: nextVersion,
        status: "CURRENT",
        aiSummary: ai.summary,
        totalCost: recomputedTotal * 100,
        perPersonCost: recomputedPerPerson * 100,
        diff: ai.changes?.length ? { changes: ai.changes } : undefined,
        items: {
          create: cleanItems.map((i, idx) => ({
            type: i.type,
            title: i.title,
            description: i.description ?? null,
            location: i.location ?? null,
            address: i.address ?? null,
            startTime: i.startTime ? new Date(i.startTime) : null,
            endTime: i.endTime ? new Date(i.endTime) : null,
            cost: i.cost != null ? i.cost * 100 : null,
            status: "Proposed",
            confirmationState: "PROPOSED",
            aiRationale: i.aiRationale ?? null,
            metadata: {
              ...(i.metadata as Record<string, unknown> | null),
              ...(lockedTitles.has(i.title.toLowerCase())
                ? { locked: true }
                : {}),
            } as object,
            orderIndex: idx,
          })),
        },
      },
    });

    await tx.chatMessage.create({
      data: {
        tripId,
        role: "ASSISTANT",
        content: ai.summary,
        metadata: {
          kind: "itinerary",
          itineraryId: it.id,
          changes: ai.changes ?? [],
        },
      },
    });

    if (ai.changes?.length && tripOwner) {
      await tx.notification.createMany({
        data: ai.changes.slice(0, 3).map((change) => ({
          tripId,
          userId: tripOwner.ownerId,
          type: "ITINERARY_REVISED" as const,
          title: "Itinerary updated",
          message: change,
        })),
        skipDuplicates: true,
      });
    }

    return it;
  }).then(async (it) => {
    await audit({
      tripId,
      action: nextVersion === 1 ? "ITINERARY_DRAFTED" : "ITINERARY_REVISED",
      title:
        nextVersion === 1
          ? "Initial itinerary drafted"
          : `Itinerary revised — v${nextVersion}`,
      detail: ai.changes?.length
        ? `Changes: ${ai.changes.slice(0, 3).join(" · ")}`
        : undefined,
      actorKind: "agent",
      actorId: "itinerary",
      metadata: { version: nextVersion },
    });
    // Run the schedule fixer in the background — it's a no-op when clean,
    // a re-optimization pass when conflicts exist. Doesn't block return.
    void import("./agents/scheduleFixer")
      .then((m) => m.runScheduleFixer(tripId))
      .catch((err) => console.error("[schedule fixer]", err));
    return it;
  });
}

/**
 * Compose a clean human title from known constraints. Only fires when the
 * existing title is one of the placeholder / form-default strings — never
 * overrides a name the user typed themselves.
 */
/**
 * Squeeze freeform destination input down to just the place name.
 * Quiz users type how they speak ("Let's go to Pinehurst and stay at
 * their resort.") — we strip the conversational filler so the trip
 * title is "Pinehurst", not the whole sentence. Heuristic-based so
 * we don't burn a model call on every quiz submission.
 */
export function cleanDestination(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  // Strip leading conversational phrases.
  s = s.replace(
    /^(let'?s\s+(?:go|head|fly|travel)\s+to|i\s+(?:want|wanna|would\s+like|need)\s+to\s+(?:go|head|fly|travel)\s+to|take\s+me\s+to|we\s+(?:should|want\s+to|wanna|need\s+to)\s+(?:go|head|fly|travel)\s+to|i'?d\s+like\s+to\s+(?:go|head|fly|travel)\s+to|going\s+to|trip\s+to|book\s+(?:us|me)\s+to|plan\s+(?:a\s+trip\s+to|me\s+a\s+trip\s+to)|how\s+about|let'?s\s+do|let'?s\s+try)\s+/i,
    "",
  );
  // Strip trailing phrases that describe what to do AT the destination.
  s = s.replace(
    /\s+(?:and|to|where\s+we'?ll|so\s+we\s+can)\s+(?:stay|sleep|book|play|golf|do|stay\s+at|stay\s+in|hang\s+out|relax|chill).*$/i,
    "",
  );
  s = s.replace(/\s+for\s+(?:a\s+)?(?:weekend|week|trip|vacation|getaway|few\s+days|long\s+weekend|guys'?\s+trip|buddies'?\s+trip).*$/i, "");
  s = s.replace(/\s+with\s+.*$/i, "");
  // Strip terminal punctuation.
  s = s.replace(/[.!?,;:]+$/g, "").trim();
  // If the user typed something like "the carolina at pinehurst", keep
  // it — that's a meaningful resort name. Don't over-truncate.
  if (s.length > 60) {
    // Last-ditch: take everything up to the first comma or "and".
    const cut = s.split(/,|\s+and\s+/i)[0];
    if (cut && cut.length >= 3) s = cut.trim();
  }
  // Reject anything that doesn't look like an actual place name —
  // pronoun-only fragments ("I want", "we should", "go somewhere"),
  // single short words that are obviously not a place, etc. When in
  // doubt, return null so the build endpoint falls back to "Surprise
  // me" mode and runs the destination agent. Far better than letting
  // "I want" become the trip's destination.
  if (s.length < 3) return null;
  const garbagePatterns = [
    /^(i|we|us|me|you|they)$/i,
    /^(want|need|wanna|like)$/i,
    /^(go|here|there|somewhere|anywhere|wherever)$/i,
    /^(maybe|idk|dunno|whatever|surprise\s+me)$/i,
    /^(nice|good|great|fun|cool)$/i,
  ];
  if (garbagePatterns.some((re) => re.test(s))) return null;
  return s.length > 0 ? s : null;
}

export function autoTitle(args: {
  currentTitle: string;
  constraints: TripConstraints;
}): string | null {
  const t = args.currentTitle.trim().toLowerCase();
  const isPlaceholder =
    t === "" ||
    t === "untitled trip" ||
    /^new trip$/i.test(args.currentTitle.trim());
  if (!isPlaceholder) return null;

  const dest = cleanDestination(args.constraints.destination);
  const group = args.constraints.groupSize;
  const startMonth = args.constraints.startDate
    ? new Date(args.constraints.startDate).toLocaleString("en-US", {
        month: "short",
      })
    : null;

  const parts: string[] = [];
  if (dest) parts.push(dest);
  if (group) parts.push(`${group} players`);
  if (startMonth) parts.push(startMonth);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function mergeConstraints(
  current: TripConstraints,
  next: TripConstraints,
): TripConstraints {
  const out: TripConstraints = { ...current };
  for (const k of Object.keys(next) as (keyof TripConstraints)[]) {
    const v = next[k];
    if (v === undefined) continue;
    // Treat null as "AI explicitly knows nothing yet" — keep the prior value
    // unless the user has actually overwritten it. The constraint extractor
    // is instructed to echo every known value so this is safe.
    if (v === null && current[k] != null) continue;
    (out as Record<string, unknown>)[k] = v as unknown;
  }
  return out;
}
