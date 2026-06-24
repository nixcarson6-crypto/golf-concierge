/**
 * Re-pick the trip's golf courses near a (just-swapped) hotel.
 *
 * When a customer moves their hotel to a different town, the courses the AI
 * picked around the OLD hotel can be an hour away. The swap endpoint detects
 * that and the trip page asks the customer if they'd like courses closer to
 * the new hotel; if they say yes, the client calls THIS endpoint.
 *
 * It is authoritative: it recomputes which courses are actually far (never
 * trusting the client), then runs ONE Haiku call to pick a comparable,
 * publicly + online-bookable course near the new hotel for each far one —
 * leaving close courses and already-booked rounds untouched.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nudge } from "@/lib/events";
import { anthropic, modelFor } from "@/lib/ai/client";
import { refundCharge } from "@/lib/payments/customer-charge";
import { assessCourseProximity } from "@/lib/course-proximity";

const bodySchema = z.object({ hotelItemId: z.string().optional() });

const courseSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  estimatedCostUSD: z.number().int().min(0).optional(),
});
const responseSchema = z.object({ courses: z.array(courseSchema) });

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ tripId: string }> },
) {
  const { tripId } = await ctx.params;
  const user = await requireUser();

  const trip = await db.trip.findFirst({
    where: { id: tripId, ownerId: user.id },
    select: { id: true, destination: true },
  });
  if (!trip) return json({ error: "not found" }, 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  const hotelItemId = parsed.success ? parsed.data.hotelItemId : undefined;

  // Anchor on the named hotel item, else the trip's (first) lodging.
  const hotel = await db.itineraryItem.findFirst({
    where: {
      type: "LODGING",
      ...(hotelItemId ? { id: hotelItemId } : {}),
      itinerary: { tripId, status: { in: ["CURRENT", "DRAFT"] } },
    },
    orderBy: { orderIndex: "asc" },
    select: { title: true, location: true },
  });
  if (!hotel) return json({ error: "No hotel on this trip to anchor on." }, 400);

  // Recompute — the client doesn't get to decide which courses move.
  const { hotelGeocoded, far } = await assessCourseProximity({
    tripId,
    hotelName: hotel.title,
    hotelLocation: hotel.location,
  });
  if (!hotelGeocoded) {
    return json(
      { error: "Couldn't locate the new hotel to find nearby courses." },
      502,
    );
  }
  if (far.length === 0) {
    // Nothing actually far (e.g. they'd already re-picked) — not an error.
    return json({ ok: true, repicked: [] }, 200);
  }

  // Names of ALL current courses so the model never re-suggests one we keep.
  const currentCourses = await db.itineraryItem.findMany({
    where: {
      type: "TEE_TIME",
      itinerary: { tripId, status: { in: ["CURRENT", "DRAFT"] } },
    },
    select: { title: true },
  });
  const avoid = currentCourses.map((c) => c.title);

  const hotelAnchor = hotel.location
    ? `${hotel.title}, ${hotel.location}`
    : hotel.title;

  const sysPrompt = `You replace golf courses on a luxury golf trip with ones CLOSE to where the customer is now staying. Return JSON ONLY, no prose, matching:
{ "courses": [ { "name": "...", "description": "...", "location": "...", "estimatedCostUSD": 0 } ] }

Return EXACTLY ${far.length} course(s), one replacement for each course listed, IN ORDER.

PROXIMITY IS THE WHOLE POINT: every course MUST be a short drive (ideally under 40 minutes) from the customer's hotel: "${hotelAnchor}". A great course an hour+ away is useless — they moved their hotel specifically to be near where they're staying.

Each course MUST be:
- A DIFFERENT venue from the ones being replaced and from every course already on the trip. NEVER suggest any of these back: ${avoid.join("; ")}.
- PUBLICLY bookable — a resort course, daily-fee/public course, or municipal that takes GUEST play. NEVER a private members-only club (Cypress Point / Rock Creek tier) — the customer can't book those.
- ONLINE-bookable — a recognizable PUBLIC or RESORT course that takes online tee-time reservations (real booking widget / on GolfNow or TeeOff / its own online tee sheet). DO NOT suggest tiny 9-hole, par-3, or small municipal courses that only take phone/pro-shop bookings.

Pick the MOST PROMINENT, well-known FULL-SIZE (18-hole) PUBLIC or RESORT course near the hotel that you're confident takes GUEST tee times online — even if it's a few more minutes' drive than some obscure local course. estimatedCostUSD = the mean per-player green fee in dollars.`;

  const userMsg = `Customer's hotel (anchor everything to this): ${hotelAnchor}
Trip destination: ${trip.destination ?? "the destination"}

Replace these ${far.length} course(s), in order, each with a comparable course CLOSE to the hotel above:
${far.map((c, i) => `${i + 1}. ${c.title}${c.location ? ` (currently ${c.location}, ~${c.distanceMi} mi from the new hotel)` : ""}`).join("\n")}`;

  let picks: z.infer<typeof courseSchema>[];
  try {
    const res = await anthropic().messages.create({
      model: modelFor("fast"),
      max_tokens: 1000,
      system: sysPrompt,
      messages: [{ role: "user", content: userMsg }],
    });
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const out = responseSchema.safeParse(JSON.parse(cleaned));
    if (!out.success || out.data.courses.length === 0) {
      return json({ error: "Couldn't find nearby courses — try again." }, 502);
    }
    picks = out.data.courses;
  } catch (err) {
    console.error("[repick-courses] Haiku call failed:", err);
    return json({ error: "Couldn't find nearby courses — try again." }, 502);
  }

  // Apply each replacement to the matching far course (by order). If the model
  // returned fewer than asked, we update as many as we got.
  const repicked: { from: string; to: string }[] = [];
  for (let i = 0; i < far.length && i < picks.length; i++) {
    const target = far[i];
    const pick = picks[i];

    const existing = await db.itineraryItem.findUnique({
      where: { id: target.itemId },
      select: { description: true, cost: true, location: true, metadata: true },
    });
    if (!existing) continue;
    const meta = (existing.metadata ?? {}) as Record<string, unknown>;

    await db.itineraryItem.update({
      where: { id: target.itemId },
      data: {
        title: pick.name,
        description: pick.description ?? existing.description,
        location: pick.location ?? existing.location,
        cost:
          pick.estimatedCostUSD != null
            ? pick.estimatedCostUSD * 100
            : existing.cost,
        // Fresh, unbooked pick — make it bookable again (mirrors the swap path).
        confirmationState: "PROPOSED",
        metadata: {
          ...meta,
          repickedAt: new Date().toISOString(),
          repickedFrom: target.title,
          repickedReason: "hotel_moved",
        },
      },
    });

    // Clear stale non-confirmed bookings on the replaced course, refunding any
    // charge first so a card-step charge never gets orphaned (mirrors swap).
    const stale = await db.booking.findMany({
      where: { itineraryItemId: target.itemId, status: { not: "CONFIRMED" } },
      select: { id: true, stripeChargeId: true },
    });
    for (const b of stale) {
      if (b.stripeChargeId) await refundCharge(b.stripeChargeId);
    }
    await db.booking.deleteMany({
      where: { itineraryItemId: target.itemId, status: { not: "CONFIRMED" } },
    });

    repicked.push({ from: target.title, to: pick.name });
  }

  nudge(tripId);
  return json({ ok: true, repicked }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
