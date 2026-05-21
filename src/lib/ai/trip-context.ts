/**
 * Build a "known context" block to prepend to the system prompt for each
 * chat turn. Gives the AI live knowledge of the trip, the current user's
 * booking profile, and each member's profile so it can auto-fill bookings
 * without re-interrogating the customer.
 */

import { db } from "@/lib/db";

type Profile = {
  legalGivenName: string | null;
  legalFamilyName: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  email: string;
  name: string | null;
};

function formatProfile(p: Profile): string {
  const parts: string[] = [];
  parts.push(`name=${p.legalGivenName ?? "?"} ${p.legalFamilyName ?? "?"}`);
  parts.push(
    `dob=${p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : "?"}`,
  );
  parts.push(`gender=${p.gender ?? "?"}`);
  parts.push(`email=${p.email}`);
  parts.push(`phone=${p.phone ?? "?"}`);
  return parts.join(", ");
}

function isProfileComplete(p: Profile): boolean {
  return Boolean(
    p.legalGivenName &&
      p.legalFamilyName &&
      p.dateOfBirth &&
      p.gender &&
      p.phone,
  );
}

export async function buildTripContext(opts: {
  tripId: string;
  currentUserId: string;
}): Promise<string> {
  const [trip, currentUser, members] = await Promise.all([
    db.trip.findUnique({
      where: { id: opts.tripId },
      select: {
        title: true,
        destination: true,
        startDate: true,
        endDate: true,
        groupSize: true,
        budgetTotal: true,
        budgetPerPerson: true,
        status: true,
      },
    }),
    db.user.findUnique({
      where: { id: opts.currentUserId },
      select: {
        email: true,
        name: true,
        legalGivenName: true,
        legalFamilyName: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
      },
    }),
    db.tripMember.findMany({
      where: { tripId: opts.tripId },
      select: {
        email: true,
        name: true,
        legalGivenName: true,
        legalFamilyName: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
      },
    }),
  ]);

  const lines: string[] = ["## Known context (do not re-ask the user for any of this)"];

  if (trip) {
    lines.push("");
    lines.push("### Trip");
    lines.push(`- Title: ${trip.title}`);
    if (trip.destination) lines.push(`- Destination: ${trip.destination}`);
    if (trip.startDate && trip.endDate) {
      lines.push(
        `- Dates: ${trip.startDate.toISOString().slice(0, 10)} → ${trip.endDate.toISOString().slice(0, 10)}`,
      );
    }
    if (trip.groupSize) lines.push(`- Group size: ${trip.groupSize}`);
    if (trip.budgetPerPerson) {
      lines.push(`- Budget per person: $${Math.round(trip.budgetPerPerson / 100)}`);
    } else if (trip.budgetTotal) {
      lines.push(`- Total budget: $${Math.round(trip.budgetTotal / 100)}`);
    }
    lines.push(`- Status: ${trip.status}`);
  }

  if (currentUser) {
    lines.push("");
    lines.push("### Trip owner / current customer");
    lines.push(`- ${formatProfile(currentUser)}`);
    if (isProfileComplete(currentUser)) {
      lines.push(
        "- Profile complete — use these values directly for the owner's slot on all bookings. DO NOT ask again.",
      );
    } else {
      const missing: string[] = [];
      if (!currentUser.legalGivenName || !currentUser.legalFamilyName)
        missing.push("legal name");
      if (!currentUser.dateOfBirth) missing.push("date of birth");
      if (!currentUser.gender) missing.push("gender (m/f)");
      if (!currentUser.phone) missing.push("phone (E.164)");
      lines.push(
        `- Profile incomplete — missing: ${missing.join(", ")}. Ask for these ONCE when you first need them, then call save_user_profile to persist so you never ask again. Use whatever you already have.`,
      );
    }
  }

  if (members.length > 0) {
    lines.push("");
    lines.push(`### Trip companions (${members.length})`);
    for (const m of members) {
      const display = m.name ?? m.email;
      lines.push(`- ${display}: ${formatProfile(m)}`);
    }
    lines.push(
      "- For companion booking slots, use any complete companion profile directly. If a companion's profile is incomplete, ask in one message and call save_member_profile to persist.",
    );
  }

  lines.push("");
  lines.push(
    "When booking, your default move is: pull profile data from this context, fill the booking tool, ticket it, announce confirmation. Only ask the customer when something is genuinely missing.",
  );

  return lines.join("\n");
}
