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
    destinations,
    members,
    notifications,
    summary,
    auditEvents,
    bookings,
  ] = await Promise.all([
    db.chatMessage.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "asc" },
      take: 100,
      include: { user: { select: { id: true, name: true, imageUrl: true } } },
    }),
    db.itinerary.findFirst({
      where: { tripId: trip.id, status: { in: ["DRAFT", "CURRENT", "APPROVED"] } },
      orderBy: { version: "desc" },
      include: { items: { orderBy: { orderIndex: "asc" } } },
    }),
    db.agentRun.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    db.destinationOption.findMany({
      where: { tripId: trip.id },
      orderBy: { rank: "asc" },
    }),
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
    db.auditEvent.findMany({
      where: { tripId: trip.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.booking.findMany({
      where: { tripId: trip.id, status: "CONFIRMED" },
      include: { itineraryItem: { select: { title: true, type: true } } },
      orderBy: { createdAt: "asc" },
    }),
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
      // Quiz-supplied flight options ready to book — written by the
      // /build endpoint after a live Duffel search. Null until the
      // quiz finishes or if we couldn't determine origin/destination.
      suggestedFlights:
        (trip.constraints as Record<string, unknown> | null)?.suggestedFlights ??
        null,
    },
    me: {
      id: me.id,
      name: me.name,
      email: me.email,
      imageUrl: me.imageUrl,
      role: access.role,
      myApproval: myMember?.approvalStatus ?? null,
      myPayment: myMember?.paymentStatus ?? null,
      // Saved traveler profile — used by the one-click booking modal
      // to pre-fill the passenger form so customers don't re-enter
      // their DOB/email/phone on every booking.
      profile: {
        legalGivenName: me.legalGivenName,
        legalFamilyName: me.legalFamilyName,
        dateOfBirth: me.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        gender: me.gender,
        phone: me.phone,
      },
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
    destinationCount: destinations.length,
    destinations: destinations.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      estimatedPerPersonCost: d.estimatedPerPersonCost,
    })),
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
    auditEvents: auditEvents.map((e) => ({
      id: e.id,
      action: e.action,
      title: e.title,
      detail: e.detail,
      actorKind: e.actorKind,
      createdAt: e.createdAt.toISOString(),
    })),
    bookings: bookings.map((b) => {
      const meta = (b.metadata ?? {}) as Record<string, unknown>;
      const slices = Array.isArray(meta.bookedSlices)
        ? (meta.bookedSlices as Array<Record<string, unknown>>).map((s) => ({
            origin: (s.origin as string | undefined) ?? "",
            destination: (s.destination as string | undefined) ?? "",
            originName: (s.originName as string | undefined) ?? null,
            destinationName: (s.destinationName as string | undefined) ?? null,
            departing: (s.departing as string | undefined) ?? "",
            arriving: (s.arriving as string | undefined) ?? "",
            flightNumber: (s.flightNumber as string | undefined) ?? null,
            marketingCarrier: (s.marketingCarrier as string | undefined) ?? null,
            cabinClass: (s.cabinClass as string | undefined) ?? null,
            stops: (s.stops as number | undefined) ?? 0,
          }))
        : null;
      // Sandbox detection: prefer the explicit metadata flag, but also
      // infer from the Duffel order id prefix so bookings made BEFORE
      // we started writing the flag are still flagged correctly.
      const explicitSandbox = Boolean(meta.isSandbox);
      const orderId =
        (meta.duffelOrderId as string | undefined) ?? b.providerReference ?? "";
      const inferredSandbox =
        orderId.startsWith("ord_test_") || orderId.includes("_test_");
      const isSandbox = explicitSandbox || inferredSandbox;
      return {
        id: b.id,
        type: b.type,
        title: b.itineraryItem?.title ?? `${b.type} booking`,
        provider: b.provider,
        confirmationCode: b.confirmationCode,
        cost: b.cost,
        status: b.status,
        isStub: Boolean(meta.isStub),
        paidAt: (meta.paidAt as string | undefined) ?? null,
        // Extra detail surfaced for the click-to-expand booking view in
        // the live trip panel. Source of truth is the partner payload
        // we recorded at booking time.
        vendor:
          (meta.airline as string | undefined) ??
          (meta.hotelName as string | undefined) ??
          (meta.courseName as string | undefined) ??
          (meta.restaurantName as string | undefined) ??
          (meta.vendor as string | undefined) ??
          null,
        summary:
          (meta.slicesSummary as string | undefined) ??
          (meta.summary as string | undefined) ??
          null,
        partyNames: Array.isArray(meta.passengerNames)
          ? (meta.passengerNames as string[])
          : Array.isArray(meta.passengers)
            ? (meta.passengers as Array<{ given_name?: string; family_name?: string }>)
                .map((p) =>
                  [p.given_name, p.family_name].filter(Boolean).join(" ").trim(),
                )
                .filter((s) => s.length > 0)
            : null,
        contactEmail: (meta.contactEmail as string | undefined) ?? null,
        leadLastName:
          ((meta.passengers as Array<{ family_name?: string }> | undefined) ?? [])[0]
            ?.family_name ?? null,
        airlineCode: (meta.airlineCode as string | undefined) ?? null,
        bookedSlices: slices,
        isSandbox,
        confirmedAt: b.confirmedAt?.toISOString() ?? null,
        providerReference: b.providerReference,
      };
    }),
  });
}
