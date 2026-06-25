/**
 * Delete the signed-in user's account — the full, irreversible teardown the
 * customer triggers from Settings → Danger zone.
 *
 * Order (each step independent so a late failure still leaves the account
 * effectively gone):
 *   1. Best-effort: delete the Stripe customer (removes the vaulted card).
 *   2. Delete the local User row. FK `onDelete: Cascade` on Trip.owner tears
 *      down every owned trip + its itineraries/bookings/notifications; the
 *      user's memberships + chat authorship get nulled (SetNull), so other
 *      people's trips are untouched.
 *   3. Delete the Clerk identity so they can't sign back in.
 */

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripe, stripeConfigured } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  const user = await requireUser();

  // 1) Stripe customer (vaulted card) — best effort; never block deletion.
  if (user.stripeCustomerId && stripeConfigured()) {
    try {
      await stripe().customers.del(user.stripeCustomerId);
    } catch (err) {
      console.warn("[account/delete] stripe customer delete failed:", err);
    }
  }

  // 2) Local data — the part the customer actually cares about being gone.
  //    Owned trips + notifications cascade off the User FK; push
  //    subscriptions have no relation/FK, so clear them explicitly first to
  //    avoid leaving orphan rows behind.
  try {
    await db.pushSubscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  } catch (err) {
    console.error("[account/delete] db user delete failed:", err);
    return NextResponse.json(
      { error: "Could not delete account data." },
      { status: 500 },
    );
  }

  // 3) Clerk identity — best effort; if it lingers, a fresh empty User row is
  //    just re-minted on next sign-in, so this isn't fatal.
  try {
    const clerk = await clerkClient();
    await clerk.users.deleteUser(user.clerkUserId);
  } catch (err) {
    console.warn("[account/delete] clerk user delete failed:", err);
  }

  return NextResponse.json({ ok: true });
}
