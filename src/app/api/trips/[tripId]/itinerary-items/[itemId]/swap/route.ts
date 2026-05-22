/**
 * Generate 3 alternative venues for an itinerary item (a different
 * restaurant, a different hotel, a different course) using ONE Haiku
 * call. The user picks one to replace the current item — no chat,
 * no agentic loop, no Opus cost.
 *
 * Two endpoints:
 *   GET  ?              — returns 3 alternatives as JSON
 *   POST { name, ... }  — applies the chosen alternative to the item
 *
 * Haiku per swap costs ~$0.002. At scale that's pennies; chat-based
 * swapping was ~$0.10-0.30 each.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { anthropic, modelFor } from "@/lib/ai/client";

const altSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string().optional(),
  estimatedCostUSD: z.number().int().min(0).optional(),
  why: z.string().describe("One short sentence on why this fits."),
});

const responseSchema = z.object({
  alternatives: z.array(altSchema).min(1).max(4),
});

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ tripId: string; itemId: string }> },
) {
  const { tripId, itemId } = await ctx.params;
  const user = await requireUser();

  const item = await db.itineraryItem.findFirst({
    where: { id: itemId, itinerary: { tripId } },
    include: { itinerary: { include: { trip: { select: { ownerId: true, destination: true } } } } },
  });
  if (!item || item.itinerary.trip.ownerId !== user.id) {
    return new Response("not found", { status: 404 });
  }

  const tripDestination = item.itinerary.trip.destination ?? "the destination";
  const itemType = item.type;
  const currentTitle = item.title;
  const currentLocation = item.location ?? tripDestination;

  const client = anthropic();
  const sysPrompt = `You suggest alternative venues for a luxury golf trip. Return JSON ONLY, no prose, matching this schema:
{ "alternatives": [ { "name": "...", "description": "...", "location": "...", "estimatedCostUSD": 0, "why": "..." } ] }
Three alternatives. Same category as the current item. Same vibe but distinctly different choices. Real venues in the area only.`;
  const userMsg = `Trip destination: ${tripDestination}
Item type: ${itemType}
Current pick: "${currentTitle}"${item.description ? ` (${item.description})` : ""}
Location: ${currentLocation}
Suggest 3 real alternatives the user could swap to.`;

  try {
    const res = await client.messages.create({
      model: modelFor("fast"),
      max_tokens: 800,
      system: sysPrompt,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    // Strip ``` fences if Haiku slipped them in.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const parsed = responseSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "Couldn't parse alternatives." }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(parsed.data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[swap] Haiku call failed:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Swap suggestions failed.",
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

const swapBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  estimatedCostUSD: z.number().int().min(0).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string; itemId: string }> },
) {
  const { tripId, itemId } = await ctx.params;
  const user = await requireUser();

  const item = await db.itineraryItem.findFirst({
    where: { id: itemId, itinerary: { tripId } },
    include: { itinerary: { include: { trip: { select: { ownerId: true } } } } },
  });
  if (!item || item.itinerary.trip.ownerId !== user.id) {
    return new Response("not found", { status: 404 });
  }

  const parsed = swapBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: "invalid body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const choice = parsed.data;

  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  await db.itineraryItem.update({
    where: { id: item.id },
    data: {
      title: choice.name,
      description: choice.description ?? item.description,
      location: choice.location ?? item.location,
      cost:
        choice.estimatedCostUSD != null
          ? choice.estimatedCostUSD * 100
          : item.cost,
      metadata: {
        ...meta,
        swappedAt: new Date().toISOString(),
        swappedFrom: item.title,
      },
    },
  });
  nudge(tripId);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
