/**
 * Admin gate for the concierge-by-hand queue.
 *
 * Single-operator by default: the founder's email is always allowed, plus
 * anyone listed in ADMIN_EMAILS (comma-separated). Keep this tight — the
 * queue exposes every customer's booking details.
 */

import { redirect } from "next/navigation";
import { optionalEnv } from "@/lib/env";
import { requireUser } from "@/lib/auth";

const FOUNDER_EMAIL = "nixcarson6@gmail.com";

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const allow = new Set(
    [
      FOUNDER_EMAIL,
      ...(optionalEnv("ADMIN_EMAILS") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ].map((s) => s.toLowerCase()),
  );
  return allow.has(e);
}

/** Server-side: require an admin user, else redirect home. Returns the user. */
export async function requireAdmin() {
  const user = await requireUser();
  if (!isAdminEmail(user.email)) redirect("/");
  return user;
}
