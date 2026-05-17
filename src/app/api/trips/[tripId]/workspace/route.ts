import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const me = await requireUser();
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [
    messages,
    itinerary,
    agentRuns,
    destinationCount,
    members,
    notifications,
    summary,
  ] = await Promise.all([
    db.chatMessage.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "asc" },
      take: 100,
      include: { user: { select: { id: true, name: true, imageUrl: true } } },
    }),
    db.itinerary.findFirst({
      where: { tripId: trip.id, status: { in: ["CURRENT", "APPROVED"] } },
      orderBy: { version: "desc" },
      include: { items: { orderBy: { orderIndex: "asc" } } },
    }),
    db.agentRun.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    db.destinationOption.count({ where: { tripId: trip.id } }),
    db.tripMember.findMany({
      where: { tripId: trip.id },
      include: { user: { select: { id: true, name: true, imageUrl: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.notification.findMany({
      where: { tripId: trip.id, userId: me.id },
      orderBy: { createdAt: "desc" },
      take: 15,
    }),
    db.tripSummary.findUnique({ where: { tripId: trip.id } }),
  ]);

  const myMember = members.find((m) => m.userId === me.id);
  const approvedCount = members.filter((m) => m.approvalStatus === "APPROVED").length;
  const total = members.length;
  const quorum = total <= 3 ? total : Math.ceil(total * (2 / 3));

  return NextResponse.json({
    trip: {
      id: trip.id,
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate?.toISOString() ?? null,
      endDate: trip.endDate?.toISOString() ?? null,
      groupSize: trip.groupSize,
      budgetTotal: trip.budgetTotal,
      budgetPerPerson: trip.budgetPerPerson,
      status: trip.status,
    },
    me: {
      id: me.id,
      name: me.name,
      imageUrl: me.imageUrl,
      role: access.role,
      myApproval: myMember?.approvalStatus ?? null,
      myPayment: myMember?.paymentStatus ?? null,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      createdAt: m.createdAt.toISOString(),
      author: m.user
        ? { id: m.user.id, name: m.user.name, imageUrl: m.user.imageUrl }
        : null,
    })),
    itinerary: itinerary
      ? {
          id: itinerary.id,
          status: itinerary.status,
          version: itinerary.version,
          aiSummary: itinerary.aiSummary,
          totalCost: itinerary.totalCost,
          perPersonCost: itinerary.perPersonCost,
          changes:
            ((itinerary.diff as { changes?: string[] } | null)?.changes) ?? [],
          items: itinerary.items.map((i) => ({
            id: i.id,
            type: i.type,
            title: i.title,
            description: i.description,
            location: i.location,
            startTime: i.startTime?.toISOString() ?? null,
            endTime: i.endTime?.toISOString() ?? null,
            cost: i.cost,
            status: i.status,
            confirmationState: i.confirmationState,
            aiRationale: i.aiRationale,
            locked: Boolean(
              (i.metadata as { locked?: boolean } | null)?.locked,
            ),
          })),
        }
      : null,
    agentRuns: agentRuns.map((r) => ({
      id: r.id,
      agentType: r.agentType,
      status: r.status,
      progress: r.progress,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    destinationCount,
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.name ?? m.user?.name ?? null,
      email: m.email,
      imageUrl: m.user?.imageUrl ?? null,
      role: m.role,
      approvalStatus: m.approvalStatus,
      paymentStatus: m.paymentStatus,
    })),
    approval: { approved: approvedCount, total, quorum },
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    summary: summary
      ? {
          shareToken: summary.shareToken,
          generatedAt: summary.generatedAt.toISOString(),
        }
      : null,
  });
}
