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
    tripLegs,
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
      include: {
        items: {
          orderBy: { orderIndex: "asc" },
          // Pull the booking summary onto each item so the dialog can render
          // live status / confirmation / screenshot without a round-trip.
          include: {
            booking: {
              select: {
                id: true,
                status: true,
                provider: true,
                confirmationCode: true,
                screenshotUrl: true,
                vendorUrl: true,
                agentRunId: true,
                metadata: true,
              },
            },
          },
        },
      },
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
    // Trip legs (multi-destination). Folded into the parallel batch so the
    // whole snapshot is one round-trip wave instead of an extra sequential
    // query — meaningful on slow connections. Single-destination trips have
    // one leg; legacy trips (pre-TripLeg) return [] → treated as single-dest.
    db.tripLeg.findMany({
      where: { tripId },
      orderBy: { legIndex: "asc" },
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
      // Multi-destination leg breakdown. Length 1 = single-destination
      // trip; length > 1 = the user requested multiple stops. UI can
      // group itinerary items by metadata.legIndex to render per-leg.
      legs: tripLegs.map((l) => ({
        id: l.id,
        index: l.legIndex,
        destination: l.destination,
        startDate: l.startDate?.toISOString() ?? null,
        endDate: l.endDate?.toISOString() ?? null,
        airportIata: l.airportIata,
      })),
    },
    me: {
      id: me.id,
      name: me.name,
      email: me.email,
      imageUrl: me.imageUrl,
      role: access.role,
      myApproval: myMember?.approvalStatus ?? null,
      myPayment: myMember?.paymentStatus ?? null,
      // Whether the customer has a card saved in the Stripe vault — gates
      // whether the agent can complete paid bookings (hotels/golf/cars)
      // end-to-end vs. stop at the payment step.
      hasSavedCard: Boolean(me.defaultPaymentMethodId),
      // Saved traveler profile — used by the one-click booking modal
      // to pre-fill the passenger form so customers don't re-enter
      // their DOB/email/phone on every booking.
      profile: {
        legalGivenName: me.legalGivenName,
        legalFamilyName: me.legalFamilyName,
        dateOfBirth: me.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        gender: me.gender,
        phone: me.phone,
        addressLine1: me.addressLine1,
        addressCity: me.addressCity,
        addressState: me.addressState,
        addressPostalCode: me.addressPostalCode,
        addressCountry: me.addressCountry,
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
          items: itinerary.items.map((i) => {
            const b = i.booking;
            const bMeta = (b?.metadata as Record<string, unknown> | null) ?? null;
            // Find the latest matching agent run for this item's booking so
            // the dialog can render the current progress string ("Filling
            // the form…", "Opening venue site…", etc.) without an extra
            // client-side join.
            const run = b?.agentRunId
              ? agentRuns.find((r) => r.id === b.agentRunId)
              : null;
            return {
              id: i.id,
              type: i.type,
              title: i.title,
              description: i.description,
              location: i.location,
              startTime: i.startTime?.toISOString() ?? null,
              endTime: i.endTime?.toISOString() ?? null,
              timeZone: i.timeZone ?? null,
              cost: i.cost,
              status: i.status,
              confirmationState: i.confirmationState,
              aiRationale: i.aiRationale,
              locked: Boolean(
                (i.metadata as { locked?: boolean } | null)?.locked,
              ),
              // Real-price provenance from the enrichment pass — lets the
              // dialog show "published rate · <source>" so the customer
              // can verify the number is real, not a guess.
              priceSource:
                (i.metadata as { priceSource?: string | null } | null)
                  ?.priceSource ?? null,
              priceBasis:
                (i.metadata as { priceBasis?: string | null } | null)
                  ?.priceBasis ?? null,
              // "required" / "walk_in" / "unknown" — set by the
              // classify-reservations build pass for DINING + ACTIVITY
              // items. Drives the UI walk-in label and skips the agent
              // for venues that don't take reservations.
              reservationNeed:
                ((i.metadata as { reservationNeed?: string } | null)
                  ?.reservationNeed as "required" | "walk_in" | "unknown" | undefined) ??
                null,
              // Venue contact (phone/website) captured at build time for
              // DINING/ACTIVITY/NIGHTLIFE/SPA — we don't auto-book those,
              // we hand the customer the number to call or email directly.
              contact:
                (i.metadata as {
                  contact?: { phone?: string | null; website?: string | null };
                } | null)?.contact ?? null,
              booking: b
                ? {
                    id: b.id,
                    status: b.status,
                    provider: b.provider,
                    confirmationCode: b.confirmationCode,
                    screenshotUrl: b.screenshotUrl,
                    vendorUrl: b.vendorUrl,
                    agentRunId: b.agentRunId,
                    liveViewUrl:
                      typeof bMeta?.liveViewUrl === "string"
                        ? (bMeta.liveViewUrl as string)
                        : null,
                    failureReason:
                      typeof bMeta?.failureReason === "string"
                        ? (bMeta.failureReason as string)
                        : null,
                    fallbackContact:
                      (bMeta?.fallbackContact as {
                        website?: string | null;
                        phone?: string | null;
                        email?: string | null;
                      } | null) ?? null,
                    amountChargedCents:
                      typeof bMeta?.amountChargedCents === "number"
                        ? (bMeta.amountChargedCents as number)
                        : null,
                    quotedPriceCents:
                      typeof bMeta?.quotedPriceCents === "number"
                        ? (bMeta.quotedPriceCents as number)
                        : null,
                    agentMessage:
                      typeof bMeta?.agentMessage === "string"
                        ? (bMeta.agentMessage as string)
                        : null,
                    agentProgress: run?.progress ?? null,
                    agentStatus: run?.status ?? null,
                  }
                : null,
            };
          }),
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
        // pay_at_property → customer settles at the venue (most golf
        // resorts, every restaurant, most courses). pay_now → Pyltrix
        // charges via Stripe upfront (flights, sometimes transport).
        // Default to pay_now for safety on legacy bookings that
        // predate this field.
        paymentMode:
          (meta.paymentMode as "pay_now" | "pay_at_property" | undefined) ??
          "pay_now",
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
