/**
 * Computes the single best "next action" the concierge would recommend
 * for the user given the current trip state. Powers the prominent
 * suggestion chip in the right rail — keeps the UI uncluttered by only
 * surfacing one thing at a time.
 */

import type {
  TripStatus,
  TripRole,
  ApprovalStatus,
  PaymentStatus,
} from "@prisma/client";

export type NextAction = {
  kind:
    | "describe-trip"
    | "pick-destination"
    | "review-itinerary"
    | "invite-group"
    | "approve"
    | "wait-on-group"
    | "pay-my-share"
    | "wait-on-bookings"
    | "view-summary"
    | "all-done";
  title: string;
  detail: string;
  href: string;
  prominent: boolean;
};

export function computeNextAction(args: {
  tripId: string;
  trip: { destination: string | null; status: TripStatus };
  itinerary: { id: string; status: string; items: { length: number }[] } | null | { id: string; status: string; items: unknown[] };
  destinationCount: number;
  memberCount: number;
  me: {
    role: TripRole;
    myApproval: ApprovalStatus | null;
    myPayment: PaymentStatus | null;
  };
  approval: { approved: number; total: number; quorum: number };
  summary: { shareToken: string | null } | null;
}): NextAction {
  const base = `/trips/${args.tripId}`;

  if (args.trip.status === "BOOKED" || args.trip.status === "COMPLETED") {
    if (args.me.myPayment !== "PAID" && args.me.myPayment !== "REFUNDED") {
      return {
        kind: "pay-my-share",
        title: "Pay your share",
        detail: "Settle up to complete the trip",
        href: `${base}/payments`,
        prominent: true,
      };
    }
    if (args.summary?.shareToken) {
      return {
        kind: "view-summary",
        title: "Open your trip dossier",
        detail: "Shareable summary is ready",
        href: `/s/${args.summary.shareToken}`,
        prominent: false,
      };
    }
    return {
      kind: "all-done",
      title: "Trip is booked",
      detail: "Nothing to do — packing optional",
      href: `${base}/summary`,
      prominent: false,
    };
  }

  if (args.trip.status === "BOOKING") {
    return {
      kind: "wait-on-bookings",
      title: "Bookings in flight",
      detail: "Confirmation codes will land in a few moments",
      href: `${base}/itinerary`,
      prominent: false,
    };
  }

  if (args.trip.status === "AWAITING_APPROVAL") {
    if (args.me.myApproval === "APPROVED") {
      return {
        kind: "wait-on-group",
        title: `Waiting on ${args.approval.total - args.approval.approved} of ${args.approval.total}`,
        detail: `Need ${args.approval.quorum} approvals to start booking`,
        href: `${base}/group`,
        prominent: false,
      };
    }
    return {
      kind: "approve",
      title: "Review and approve",
      detail: "Your call kicks off the booking workflow",
      href: `${base}/itinerary`,
      prominent: true,
    };
  }

  // PLANNING or DRAFT
  if (!args.trip.destination && args.destinationCount === 0) {
    return {
      kind: "describe-trip",
      title: "Describe your trip",
      detail: "Group size, dates, vibe — the concierge takes it from there",
      href: base,
      prominent: true,
    };
  }
  if (!args.trip.destination && args.destinationCount > 0) {
    return {
      kind: "pick-destination",
      title: "Pick a destination",
      detail: `${args.destinationCount} options are ready to review`,
      href: `${base}/destination`,
      prominent: true,
    };
  }
  if (!args.itinerary) {
    return {
      kind: "describe-trip",
      title: "Refine the brief",
      detail: "Add dates, group size, or vibe to draft your itinerary",
      href: base,
      prominent: true,
    };
  }
  if (args.memberCount <= 1 && args.me.role === "OWNER") {
    return {
      kind: "invite-group",
      title: "Invite your group",
      detail: "They'll approve and pay independently",
      href: `${base}/group`,
      prominent: false,
    };
  }
  if (args.me.role === "OWNER") {
    return {
      kind: "approve",
      title: "Approve & book",
      detail: "One click triggers the full workflow",
      href: `${base}/itinerary`,
      prominent: true,
    };
  }
  if (args.me.myApproval !== "APPROVED") {
    return {
      kind: "approve",
      title: "Review the plan",
      detail: "Your approval helps the group reach quorum",
      href: `${base}/itinerary`,
      prominent: true,
    };
  }
  return {
    kind: "wait-on-group",
    title: "Waiting on the group",
    detail: "You're set — others still need to approve",
    href: `${base}/group`,
    prominent: false,
  };
}
