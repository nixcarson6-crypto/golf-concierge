import { db } from "@/lib/db";
import type { Trip } from "@prisma/client";
import { runConstraintExtractor } from "./agents/constraintExtractor";
import { runDestinationAgent } from "./agents/destination";
import { runItineraryAgent } from "./agents/itinerary";
import type { AgentMessage } from "./orchestrator";
import type { ItineraryAI, TripConstraints } from "./schemas";
import { nudge } from "@/lib/events";
import { audit } from "@/lib/audit";
import { parseWallClock, validIanaTz } from "./time";

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
  // Wrap the actual write in a small retry loop. The (tripId, version)
  // pair is uniquely constrained at the schema level, and `nextVersion`
  // is computed by reading the latest version *before* the transaction
  // — so if two builds race (e.g. user retries on slow network, Fast
  // Refresh re-fires, or two tabs are open), both can compute the same
  // version and the loser hits P2002. Recompute and retry up to 5x.
  // Real users will never see this; the race is purely an artefact of
  // overlapping requests.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await persistItineraryOnce(tripId, ai);
    } catch (err) {
      const code =
        err != null && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : null;
      const isVersionRace = code === "P2002";
      if (!isVersionRace || attempt === MAX_ATTEMPTS - 1) throw err;
      console.warn(
        `[persistItinerary] (tripId,version) race on attempt ${attempt + 1} — retrying`,
      );
      // Jittered backoff so concurrent writers don't lock-step into
      // another collision on the very next attempt.
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("persistItinerary: exhausted retries");
}

async function persistItineraryOnce(tripId: string, ai: ItineraryAI) {
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
    // Only FLIGHT prices are real (live from Duffel). LODGING /
    // TEE_TIME / TRANSPORT used to be 'priceable' but the AI was just
    // guessing from training-data hotel rates / green fees / Uber
    // surge — Carson's explicit call: don't show guessed prices on the
    // itinerary. The cost field on those types gets nulled before
    // persistence; the UI hides the dollar line and the trip total
    // only sums what we ACTUALLY know. Once Hotelbeds / GolfNow /
    // Uber-Guest-Rides land, add their types back to PRICEABLE.
    const PRICEABLE = new Set(["FLIGHT"]);
    // Drop noise line items the AI sometimes invents even when the
    // prompt forbids them. "Fuel / gas / mileage / incidental driving
    // budget / parking / tolls" make Pyltrix look like a budget app —
    // luxury customers don't want a spreadsheet.
    const NOISE_PATTERNS = [
      /\bfuel\b/i,
      /\bgas\b/i,
      /\bmileage\b/i,
      /\bincidental(s)?\b/i,
      /\bparking\b/i,
      /\btolls?\b/i,
    ];
    const cleanItems = ai.items
      .filter((i) => {
        const haystack = `${i.title ?? ""} ${i.description ?? ""}`;
        return !NOISE_PATTERNS.some((rx) => rx.test(haystack));
      })
      .map((i) => ({
        ...i,
        cost: PRICEABLE.has(i.type) ? i.cost : null,
      }));
    // HARD GUARANTEE — never list the same hotel twice. The AI sometimes
    // emits a property as two LODGING items (a Taormina→Verdura→Taormina
    // bookend that repeats the first hotel, or two suites at one resort).
    // Collapse LODGING items pointing at the SAME property to the first
    // occurrence. (Two GENUINELY different hotels keep different keys and
    // both survive — keeping them near the golf is the prompt's job; this
    // only kills the literal duplicate the customer should never see.)
    const seenHotels = new Set<string>();
    const dedupedItems = cleanItems.filter((i) => {
      if (i.type !== "LODGING") return true;
      const key = (i.title ?? "")
        .toLowerCase()
        .split(/[—–-]/)[0] // drop a "— Junior Suite" room descriptor
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (!key) return true;
      if (seenHotels.has(key)) {
        console.warn(`[persistItinerary] dropped duplicate hotel "${i.title}".`);
        return false;
      }
      seenHotels.add(key);
      return true;
    });
    const recomputedTotal = dedupedItems.reduce(
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
          create: dedupedItems.map((i, idx) => ({
            type: i.type,
            title: i.title,
            description: i.description ?? null,
            location: i.location ?? null,
            address: i.address ?? null,
            startTime: parseWallClock(i.startTime),
            endTime: parseWallClock(i.endTime),
            timeZone: validIanaTz(
              (i as { timeZone?: string | null }).timeZone,
            ),
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
  }, {
    // Default Prisma interactive-transaction timeout is 5s — too tight
    // for multi-leg trips (more items + the supersede sweep + the
    // notification fan-out). Bump to 30s so realistic large itineraries
    // commit without false aborts.
    //
    // maxWait is how long Prisma will queue waiting for a free pool
    // slot before giving up with "Unable to start a transaction in the
    // given time". On slow networks the /workspace poll holds 1-2
    // connections at a time and a typical build runs other queries in
    // parallel (member prefs, conversation summary, etc.); 15s was
    // tight enough that hotspot users hit it. 60s gives real headroom
    // without papering over a genuinely-stuck pool.
    maxWait: 60000,
    timeout: 30000,
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
  // Strip leading conversational phrases. The verb group accepts an
  // optional adverb ("over", "down", "out", "up", "across") between the
  // verb and "to" so "head over to Alabama" / "fly out to Bandon" /
  // "go down to Pinehurst" all get cleaned to just the place name.
  // The BARE verb form ("head over to streamsong resort") is stripped
  // too — users often skip the "I want to" / "let's" preamble and just
  // type the directive.
  s = s.replace(
    /^(let'?s\s+(?:go|head|fly|travel|drive)(?:\s+(?:over|down|out|up|across|on))?\s+to|i\s+(?:want|wanna|would\s+like|need)\s+to\s+(?:go|head|fly|travel|drive)(?:\s+(?:over|down|out|up|across|on))?\s+to|take\s+me\s+to|we\s+(?:should|want\s+to|wanna|need\s+to)\s+(?:go|head|fly|travel|drive)(?:\s+(?:over|down|out|up|across|on))?\s+to|i'?d\s+like\s+to\s+(?:go|head|fly|travel|drive)(?:\s+(?:over|down|out|up|across|on))?\s+to|going\s+to|trip\s+to|book\s+(?:us|me)\s+to|plan\s+(?:a\s+trip\s+to|me\s+a\s+trip\s+to)|how\s+about|let'?s\s+do|let'?s\s+try|(?:head|go|fly|drive|travel)\s+(?:over|down|out|up|across|on)\s+to|(?:head|fly|drive|travel)\s+to)\s+/i,
    "",
  );
  // EXTRACT the place from desire/activity sentences the regex above
  // doesn't cover, instead of letting the whole string get rejected as
  // conversational further down. That rejection is how a customer who
  // typed "I want to go to Montenegro and play golf" ended up routed to
  // the destination agent — which sent them to Bandon Dunes. Peel layers
  // in order: desire opener → bare movement verb → activity-with-
  // preposition lead-in. Whatever survives is the place.
  //   "i wanna go to montenegro and play golf"  → "montenegro and play golf"
  //   "I want to play golf in Montenegro"       → "play golf in Montenegro"
  s = s.replace(
    /^(?:i|we)(?:'d)?\s+(?:want|wanna|need|would\s+(?:like|love)|d\s+(?:like|love))\s+(?:to\s+)?/i,
    "",
  );
  s = s.replace(
    /^(?:go|head|fly|travel|drive)\s+(?:over\s+|down\s+|out\s+|up\s+|across\s+)?to\s+/i,
    "",
  );
  // "play golf in X" / "golf in X" / "play a round at X" → "X"
  s = s.replace(
    /^(?:go\s+)?(?:play(?:ing)?\s+)?(?:some\s+)?(?:golf(?:ing)?|a\s+round(?:\s+of\s+golf)?|\d+\s+rounds?(?:\s+of\s+golf)?)\s+(?:in|at|around|near)\s+/i,
    "",
  );
  // Strip trailing phrases that describe what to do AT the destination.
  // Verb list mirrors the bare-imperative garbage check below — any
  // verb that's a directive ("find the closest course", "pick the
  // best hotel", "see the sights") should peel off as filler, not
  // become part of the trip title.
  s = s.replace(
    /\s+(?:and|to|where\s+we'?ll|so\s+we\s+can)\s+(?:stay|sleep|book|play|golf|do|stay\s+at|stay\s+in|hang\s+out|relax|chill|find|pick|explore|see|visit|check|try|grab|get|eat|drink|tour|shop|hit|swim|surf|ski).*$/i,
    "",
  );
  // Strip trailing "vibe / leftover-time" clauses. "Vail Colorado, the
  // rest of the days just chill" → "Vail Colorado". "Pebble Beach and
  // then just relax" → "Pebble Beach". These describe what to DO with
  // the time, not a second place — so we keep the real destination and
  // drop the filler instead of nuking the whole string.
  s = s.replace(
    /[,;]?\s*(?:and\s+|then\s+|&\s+)*(?:the\s+)?(?:rest\s+of\b.*|just\s+(?:chill|relax|hang|wing).*|chill\b.*|relax\b.*|unwind\b.*|wing\s+it\b.*|hang\s*out\b.*|do\s+nothing\b.*|free\s+time\b.*)$/i,
    "",
  );
  s = s.replace(/\s+for\s+(?:a\s+)?(?:weekend|week|trip|vacation|getaway|few\s+days|long\s+weekend|guys'?\s+trip|buddies'?\s+trip).*$/i, "");
  // "montenegro golf trip" → "montenegro" (trailing trip-type descriptor).
  s = s.replace(/\s+golf(?:ing)?\s+(?:trip|vacation|getaway|holiday)$/i, "");
  s = s.replace(/\s+with\s+.*$/i, "");
  // Strip a trailing first-person desire clause that got glued onto the
  // place when a connector split ate the verb's "to" — "Positano I want
  // [to play golf]" → "Positano". Without this the junk lands in the
  // trip TITLE ("Positano I Want").
  s = s.replace(/\s+(?:i|we)\s+(?:want|wanna|need|would|like|hope|wish|love|just)\b.*$/i, "");
  // Strip terminal punctuation.
  s = s.replace(/[.!?,;:]+$/g, "").trim();
  // Multi-destination input ("Pinehurst for 5 days then Broadmoor for 4")
  // → take the first leg as the primary destination. The build endpoint
  // also stores the full original string in `notes` so the itinerary
  // agent knows the user wants both legs.
  const multiLegSplit = s.split(
    /\s+(?:then|and\s+then|plus|after\s+that|followed\s+by)\s+/i,
  );
  if (multiLegSplit.length > 1 && multiLegSplit[0].length >= 3) {
    s = multiLegSplit[0].trim();
  }
  // Strip trailing "for N days/nights" duration phrases.
  s = s.replace(/\s+for\s+\d+\s+(?:day|night|week)s?\s*$/i, "").trim();
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
    // Multi-word verb phrases that survived the prefix strip — anything
    // that STARTS with one of these is a conversational fragment, not a
    // place name. Catches "I want", "I want to", "we want to play",
    // "let's go somewhere", "play their nicest", "pick the best",
    // "find me a", "show me", "give us", "book me a"…
    /^(i|we|you|they|us)\s+(want|need|wanna|would|gonna|going|should|might|could|hope|love|like|plan|think)\b/i,
    /^(let'?s|let\s+(?:us|me))\s+/i,
    // ANY bare imperative verb followed by another word is a directive,
    // not a place name. "Play golf" / "Play their nicest" / "Stay at
    // the nicest hotels" / "Eat at fancy restaurants" / "Drive there"
    // — all conversational. Real golf-destination names don't start
    // with these verbs (Playa del Carmen has the 'a'; the rest are
    // safe). When parseLegs is strict-fail, false-rejections here just
    // route through the destination agent, which is fine.
    /^(play|stay|eat|drink|sleep|relax|chill|enjoy|hit|swim|surf|ski|shop|tour|explore|drive|find|pick|book|show|give|get|grab|do|see|visit|check|try|head|fly|go|take)\s+\S+/i,
    // Conditional / clause openers — "if", "only if", "but", "unless",
    // "that'd be nice", "maybe", "hopefully". These start dependent
    // clauses, not place names.
    /^(if|only|but|unless|maybe|hopefully|ideally|preferably|possibly|otherwise|though|although|whereas)\b/i,
    /^(that'?d|that'?s|that\s+is|that\s+would|i'?d|i'?ll|we'?d|we'?ll)\b/i,
    // Descriptive determiner + superlative — "the top-rated course",
    // "the best place", "the cheapest hotel", "the nicest resort".
    // These describe what the user WANTS, they're not a name.
    /^the\s+(top[\s-]?rated|best|cheapest|nicest|finest|greatest|top|fanciest|most[\s-]?expensive|highest[\s-]?rated|coolest|hottest|trendiest|cheapest|priciest)\b/i,
    // Article + adjective + noun ("a links course", "an island
    // hideaway") — these are descriptions, not names. Real venue
    // names don't typically start with "a"/"an" + adjective.
    /^(a|an)\s+\w+\s+(course|resort|hotel|club|destination|place|spot|trip)\b/i,
    // Vibe / filler phrases that aren't destinations — "the rest of the
    // days just chill", "rest of the trip relax", "chill the rest",
    // "do nothing", "hang out". These describe what to DO with leftover
    // time, not WHERE to go. Without this, a connector-split leg like
    // "Vail [and] the rest of the days just chill" turns the filler into
    // its own destination and the agent picks a random place for it.
    /^(the\s+)?rest\s+of\b/i,
    /^(just\s+)?(chill|relax|unwind|rest|wing\s+it|hang\s+out|do\s+nothing|free\s+time|whatever\s+else)\b/i,
    // Bare travel-connector fragments stranded by the "to" splitter:
    // "austria then HEAD OVER TO positano" splits on then/to and leaves
    // "head over" (or the one-word "headover") as its own "leg". It then
    // becomes a phantom destination — the agent once hallucinated a
    // Ritz-Carlton DALLAS (the user's origin city!) for it. \s* covers
    // the no-space dictation form.
    /^(?:head|hop|go|move|fly|drive|travel|press|carry)\s*(?:over|on|out|down|up|across|along|onwards?)$/i,
    /^(?:continue|onwards?|next|afterwards?|after\s+that)$/i,
    // RELATIVE references, not place names — "the closest course there",
    // "nearest hotel nearby", "the course near there". A user types these as
    // a HINT ("Venice / the closest course there") and the slash/connector
    // splitter turns the hint into a phantom destination ("The Closet Course
    // There"). Resolve to null so the leg is dropped and the itinerary agent
    // just picks the real course nearest the actual destination.
    /^the\s+(closest|closet|nearest|nearby|local|surrounding)\b/i,
    /\b(closest|closet|nearest|nearby)\s+(course|courses?|hotel|resort|club|place|spot|town|city|airport|one|golf)\b/i,
    /\b(course|courses?|hotel|resort|club|place|spot)s?\s+(there|nearby|close\s?by|around\s+(there|here)|in\s+the\s+area)\b/i,
  ];
  if (garbagePatterns.some((re) => re.test(s))) return null;
  // Sentence-shape rejections:
  //   - Mid-string period followed by space + more text → multi-sentence
  //     input, not a place name ("Tennessee. If they have a resort…").
  //   - Contains common conversational connectives that don't belong in
  //     any real venue name ("if", "but", "only", "unless", "would",
  //     "could", "should", "might", "maybe"). Real names like
  //     "The Inn at Spanish Bay" survive (no conditional tokens).
  // Sentence-shape check, but FIRST strip the periods on common
  // place-name abbreviations so they don't get mistaken for sentence
  // boundaries. "St. Moritz", "Mt. Whitney", "Ste. Genevieve",
  // "Ft. Lauderdale" are real place names, not multi-sentence input.
  const stripped = s.replace(
    /\b(st|mt|ste|sta|ft|fort|mont|pt|sr|jr)\.\s+/gi,
    "$1 ",
  );
  if (/\.\s+\S/.test(stripped)) return null;
  if (/\b(if|but|only|unless|would|could|should|might|maybe|preferably|ideally|honestly|basically|otherwise)\b/i.test(s)) return null;
  return s.length > 0 ? titleCaseDestination(s) : null;
}

/**
 * Title-case a destination string so user-typed input ("erin hills",
 * "bandon dunes") renders as "Erin Hills" / "Bandon Dunes" in headers,
 * tabs, and tiles. Preserves all-caps tokens (DFW, USA), articles
 * stay lowercase mid-string ("The Carolina at Pinehurst" → keep "at"
 * lowercase), and apostrophed words ("St. Andrew's") survive.
 */
function titleCaseDestination(s: string): string {
  const SMALL_WORDS = new Set([
    "of", "the", "at", "in", "on", "and", "or", "a", "an", "to", "for",
    "de", "del", "la", "las", "los", "le", "les", "di", "da", "do",
  ]);
  const words = s.split(/(\s+|[-/])/);
  return words
    .map((w, i) => {
      if (/^\s+$/.test(w) || w === "-" || w === "/") return w;
      // Already mixed-case (McLean) or all-caps abbrev (DFW, USA) — leave it.
      if (/[A-Z]/.test(w) && /[a-z]/.test(w)) return w;
      if (/^[A-Z]{2,}$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      // Capitalize first letter; preserve internal apostrophes/periods.
      return lower.replace(
        /([\p{L}])(\p{L}*)/u,
        (_m, first: string, rest: string) => first.toUpperCase() + rest,
      );
    })
    .join("");
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
