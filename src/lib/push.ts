import webpush from "web-push";
import { db } from "./db";
import { optionalEnv } from "./env";

/**
 * Web Push notifications via VAPID. Premium-feel "feels-like-an-app"
 * delivery — members get nudged when an itinerary is approved, a booking
 * confirms, a payment lands, etc.
 *
 * Configured via VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env. When not
 * configured we no-op gracefully — the DB-backed Notification feed still
 * works.
 */

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = optionalEnv("VAPID_PUBLIC_KEY" as never);
  const priv = optionalEnv("VAPID_PRIVATE_KEY" as never);
  const subject = optionalEnv("VAPID_SUBJECT" as never) ?? "mailto:concierge@example.com";
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subject as string, pub as string, priv as string);
  configured = true;
  return true;
}

export function pushConfigured() {
  // Read directly from process.env so we don't need to extend the typed
  // env() definitions for these (they're optional and partner-style).
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function pushPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? process.env.VAPID_PUBLIC_KEY ?? null;
}

export async function pushToUser(args: {
  userId: string;
  title: string;
  body: string;
  url?: string;
}) {
  if (!ensureConfigured()) return { sent: 0 };
  const subs = await db.pushSubscription.findMany({
    where: { userId: args.userId },
  });
  if (subs.length === 0) return { sent: 0 };

  const payload = JSON.stringify({
    title: args.title,
    body: args.body,
    url: args.url ?? "/",
  });

  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          payload,
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        // 410 = subscription gone; remove it.
        if (status === 404 || status === 410) {
          await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          console.warn("[push] send failed", err);
        }
      }
    }),
  );
  return { sent };
}

export async function pushToTrip(args: {
  tripId: string;
  title: string;
  body: string;
  url?: string;
  excludeUserId?: string | null;
}) {
  const members = await db.tripMember.findMany({
    where: { tripId: args.tripId, userId: { not: null } },
    select: { userId: true },
  });
  let totalSent = 0;
  await Promise.all(
    members
      .filter((m) => m.userId && m.userId !== args.excludeUserId)
      .map(async (m) => {
        const { sent } = await pushToUser({
          userId: m.userId!,
          title: args.title,
          body: args.body,
          url: args.url,
        });
        totalSent += sent;
      }),
  );
  return { sent: totalSent };
}
