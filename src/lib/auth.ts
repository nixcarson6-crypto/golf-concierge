import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "./db";
import type { TripRole } from "@prisma/client";

/**
 * Ensures the requesting Clerk user is mirrored to a local `User` row.
 * The Clerk webhook also handles this, but we sync on-demand to remove a
 * race condition on the very first request after sign-up.
 */
export async function getOrCreateUser() {
  const { userId } = await auth();
  if (!userId) return null;

  const existing = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (existing) return existing;

  const clerk = await currentUser();
  if (!clerk) return null;

  const primaryEmail =
    clerk.emailAddresses.find((e) => e.id === clerk.primaryEmailAddressId)
      ?.emailAddress ?? clerk.emailAddresses[0]?.emailAddress;

  if (!primaryEmail) return null;

  return db.user.upsert({
    where: { clerkUserId: userId },
    create: {
      clerkUserId: userId,
      email: primaryEmail,
      name:
        [clerk.firstName, clerk.lastName].filter(Boolean).join(" ").trim() ||
        clerk.username ||
        null,
      imageUrl: clerk.imageUrl,
    },
    update: {
      email: primaryEmail,
      name:
        [clerk.firstName, clerk.lastName].filter(Boolean).join(" ").trim() ||
        clerk.username ||
        null,
      imageUrl: clerk.imageUrl,
    },
  });
}

export async function requireUser() {
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  return user;
}

export type TripAccess = {
  trip: Awaited<ReturnType<typeof loadTrip>>;
  role: TripRole;
};

async function loadTrip(tripId: string) {
  return db.trip.findUnique({
    where: { id: tripId },
    include: { members: true },
  });
}

/**
 * Verifies the current user has access to the given trip and returns the
 * trip + their role. Throws a Response-like error suitable for route handlers
 * or `notFound()`-ish behaviour at the server-component level.
 */
export async function requireTripAccess(
  tripId: string,
  opts: { minimumRole?: TripRole } = {},
): Promise<TripAccess> {
  const user = await requireUser();
  const trip = await loadTrip(tripId);
  if (!trip) throw new Error("Trip not found");

  let role: TripRole | null = null;
  if (trip.ownerId === user.id) role = "OWNER";
  else {
    const member = trip.members.find((m) => m.userId === user.id);
    if (member) role = member.role;
  }
  if (!role) throw new Error("Forbidden");

  if (opts.minimumRole) {
    const rank: Record<TripRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };
    if (rank[role] < rank[opts.minimumRole]) throw new Error("Forbidden");
  }

  return { trip, role };
}
