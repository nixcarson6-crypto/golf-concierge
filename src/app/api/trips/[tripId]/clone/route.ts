import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clone a trip to seed a new one — copies title (with " — copy"), constraints,
 * group size, luxury level; resets dates, itinerary, bookings, payments.
 * Lets the user say "like the Scottsdale trip but in October" by cloning
 * and then asking the concierge in chat.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const user = await requireUser();
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const orig = access.trip;
  const cloned = await db.trip.create({
    data: {
      ownerId: user.id,
      title: `${orig.title} — copy`,
      destination: orig.destination,
      groupSize: orig.groupSize,
      budgetTotal: orig.budgetTotal,
      budgetPerPerson: orig.budgetPerPerson,
      luxuryLevel: orig.luxuryLevel,
      currency: orig.currency,
      constraints: (orig.constraints as object | null) ?? undefined,
      status: "PLANNING",
      members: {
        create: {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: "OWNER",
          joinedAt: new Date(),
          approvalStatus: "APPROVED",
        },
      },
      chatMessages: {
        create: {
          role: "ASSISTANT",
          content: `Cloned "${orig.title}". Tell me what you want to change — dates, destination, vibe — and I'll redraft.`,
        },
      },
    },
  });

  return NextResponse.json({ ok: true, tripId: cloned.id });
}
