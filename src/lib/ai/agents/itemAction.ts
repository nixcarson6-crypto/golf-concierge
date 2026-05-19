import { z } from "zod";
import { db } from "@/lib/db";
import { runStructured, withAgentRun } from "../orchestrator";
import { CONCIERGE_VOICE } from "../prompts";
import { itineraryItemSchema, type TripConstraints } from "../schemas";
import {
  destinationBriefForAI,
  findDestination,
} from "@/lib/data/destinations";
import { nudge } from "@/lib/events";

const SINGLE_ITEM_SYSTEM = `
${CONCIERGE_VOICE}

You are the single-item agent. The user wants ONE item in their itinerary
changed — usually because they want a substitute, an upgrade, or a downgrade
of just that line. Produce exactly ONE replacement item with the same shape
as the original, anchored to the destination brief.

Rules:
- Keep the same TYPE unless the user explicitly asked to change it.
- Keep startTime/endTime close to the original (preserve the pacing).
- Use real venue names from the DESTINATION_BRIEF.
- 'cost' = USD whole dollars for the whole group (multiply by partySize when
  applicable). Stay in the same ballpark unless the user asked for cheaper/fancier.
- 'aiRationale' is one sentence on WHY this fits this group.
- 'metadata' includes party/room/leg specifics in JSON.
`.trim();

const responseSchema = z.object({
  item: itineraryItemSchema,
  rationale: z.string().describe("Short chat-message-style note about the swap"),
});

export type ItemActionKind = "swap" | "upgrade" | "downgrade" | "regenerate";

export type ItemActionInput = {
  tripId: string;
  itemId: string;
  action: ItemActionKind;
  /** Optional free-form instruction, e.g. "cheaper steakhouse" */
  instruction?: string | null;
};

export async function runItemAction(input: ItemActionInput) {
  const item = await db.itineraryItem.findUnique({
    where: { id: input.itemId },
    include: { itinerary: { include: { trip: true, items: true } } },
  });
  if (!item) throw new Error("itinerary item not found");
  const trip = item.itinerary.trip;
  const dest = trip.destination
    ? destinationBriefForAI(findDestination(trip.destination)!)
    : null;

  return withAgentRun({
    tripId: trip.id,
    agentType: "ITINERARY",
    input: {
      itemId: input.itemId,
      action: input.action,
      instruction: input.instruction ?? null,
    },
    progress:
      input.action === "upgrade"
        ? "Upgrading that item…"
        : input.action === "downgrade"
          ? "Finding a value alternative…"
          : input.action === "swap"
            ? "Swapping that item…"
            : "Regenerating…",
    fn: async () => {
      const intent =
        input.action === "upgrade"
          ? "Upgrade this item — pick a meaningfully better/fancier alternative for this group."
          : input.action === "downgrade"
            ? "Downgrade this item — pick a notable cost-saver without obviously worse quality."
            : input.action === "swap"
              ? `Substitute this item${input.instruction ? ` per: "${input.instruction}"` : " for an equally strong alternative"}.`
              : "Regenerate this item with a fresh recommendation in the same shape.";

      const constraints = (trip.constraints as TripConstraints | null) ?? {};
      const surrounding = item.itinerary.items.map((i) => ({
        type: i.type,
        title: i.title,
        startTime: i.startTime?.toISOString() ?? null,
        cost: i.cost ? Math.round(i.cost / 100) : null,
      }));

      const userMessage = [
        dest
          ? `DESTINATION_BRIEF:\n${JSON.stringify(dest, null, 2)}\n`
          : `(No KB for ${trip.destination}; draw on what you know honestly.)\n`,
        `Trip constraints:\n${JSON.stringify(constraints, null, 2)}\n`,
        `Other items already on the itinerary (so you don't conflict):\n${JSON.stringify(surrounding, null, 2)}\n`,
        `Item to change:\n${JSON.stringify(
          {
            type: item.type,
            title: item.title,
            description: item.description,
            location: item.location,
            startTime: item.startTime?.toISOString() ?? null,
            endTime: item.endTime?.toISOString() ?? null,
            cost: item.cost ? Math.round(item.cost / 100) : null,
            aiRationale: item.aiRationale,
            metadata: item.metadata,
          },
          null,
          2,
        )}`,
        ``,
        `Intent: ${intent}`,
      ].join("\n");

      const result = await runStructured({
        tier: "orchestrator",
        system: SINGLE_ITEM_SYSTEM,
        schema: responseSchema,
        toolName: "emit_single_item",
        toolDescription: "Emit the replacement item and a short rationale.",
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 1500,
        temperature: 0.55,
      });

      const replaced = result.item;
      await db.itineraryItem.update({
        where: { id: item.id },
        data: {
          type: replaced.type,
          title: replaced.title,
          description: replaced.description ?? null,
          location: replaced.location ?? null,
          address: replaced.address ?? null,
          startTime: replaced.startTime ? new Date(replaced.startTime) : null,
          endTime: replaced.endTime ? new Date(replaced.endTime) : null,
          cost: replaced.cost != null ? replaced.cost * 100 : null,
          aiRationale: replaced.aiRationale ?? null,
          metadata: (replaced.metadata as object | null) ?? undefined,
          confirmationState: "PROPOSED",
          status: "Updated",
        },
      });

      // Recompute itinerary totals.
      const items = await db.itineraryItem.findMany({
        where: { itineraryId: item.itineraryId },
      });
      const totalCents = items.reduce((s, i) => s + (i.cost ?? 0), 0);
      const groupSize = trip.groupSize ?? 1;
      await db.itinerary.update({
        where: { id: item.itineraryId },
        data: {
          totalCost: totalCents,
          perPersonCost: Math.round(totalCents / Math.max(1, groupSize)),
        },
      });

      await db.chatMessage.create({
        data: {
          tripId: trip.id,
          role: "ASSISTANT",
          content: result.rationale,
          metadata: { kind: "item_update", itemId: item.id, action: input.action },
        },
      });
      nudge(trip.id);

      return { itemId: item.id, action: input.action, rationale: result.rationale };
    },
  });
}

export type ItemLockInput = { itemId: string; locked: boolean };

export async function setItemLock(
  tripId: string,
  { itemId, locked }: ItemLockInput,
) {
  const item = await db.itineraryItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("not found");
  const meta = ((item.metadata as Record<string, unknown> | null) ?? {});
  meta.locked = locked;
  await db.itineraryItem.update({
    where: { id: itemId },
    data: { metadata: meta as object },
  });
  nudge(tripId);
}
