import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { db } from "./db";
import type { TripRole } from "@prisma/client";

/**
 * Ensures the requesting Clerk user is mirrored to a local `User` row.
 * The Clerk webhook also handles this, but we sync on-demand to remove a
 * race condition on the very first request after sign-up.
 *
 * Also handles the case where the Clerk user id changes for the same email
 * (e.g. keyless dev mode mints a fresh user id each session, or a user is
 * deleted + recreated in Clerk) — we rebind the existing User row to the
 * new clerkUserId instead of failing on the unique email constraint.
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

  const name =
    [clerk.firstName, clerk.lastName].filter(Boolean).join(" ").trim() ||
    clerk.username ||
    null;

  const existingByEmail = await db.user.findUnique({
    where: { email: primaryEmail },
  });
  if (existingByEmail) {
    return db.user.update({
      where: { id: existingByEmail.id },
      data: { clerkUserId: userId, name, imageUrl: clerk.imageUrl },
    });
  }

  return db.user.create({
    data: {
      clerkUserId: userId,
      email: primaryEmail,
      name,
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
