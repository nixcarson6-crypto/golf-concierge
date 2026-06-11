import { headers } from "next/headers";
import { Webhook } from "svix";
import type { WebhookEvent } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { env, optionalEnv } from "@/lib/env";
import { sendEmail, renderWelcomeEmail } from "@/lib/email";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = env("CLERK_WEBHOOK_SECRET");
  if (!secret) return new Response("clerk webhook not configured", { status: 503 });

  const h = await headers();
  const id = h.get("svix-id");
  const timestamp = h.get("svix-timestamp");
  const signature = h.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return new Response("missing svix headers", { status: 400 });
  }

  const payload = await req.text();
  let evt: WebhookEvent;
  try {
    evt = new Webhook(secret).verify(payload, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    }) as WebhookEvent;
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  switch (evt.type) {
    case "user.created":
    case "user.updated": {
      const u = evt.data;
      const primaryEmail =
        u.email_addresses.find((e) => e.id === u.primary_email_address_id)
          ?.email_address ?? u.email_addresses[0]?.email_address;
      if (!primaryEmail) break;
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username || null;
      // Detect a genuinely-new signup so we send the welcome email exactly
      // once — Clerk fires user.updated on every profile change too.
      const existing = await db.user.findUnique({
        where: { clerkUserId: u.id },
        select: { id: true },
      });
      await db.user.upsert({
        where: { clerkUserId: u.id },
        create: {
          clerkUserId: u.id,
          email: primaryEmail,
          name,
          imageUrl: u.image_url,
        },
        update: {
          email: primaryEmail,
          name,
          imageUrl: u.image_url,
        },
      });
      if (evt.type === "user.created" && !existing) {
        // Best-effort welcome email; never block the webhook on mail.
        const appUrl = optionalEnv("NEXT_PUBLIC_APP_URL") ?? "https://pyltrix.com";
        const mail = renderWelcomeEmail({ name, appUrl: `${appUrl}/trips/new` });
        sendEmail({ to: primaryEmail, subject: mail.subject, html: mail.html, text: mail.text }).catch(
          (e) => console.warn("[clerk-webhook] welcome email failed:", e),
        );
      }
      break;
    }
    case "user.deleted": {
      if (evt.data.id) {
        await db.user.deleteMany({ where: { clerkUserId: evt.data.id } });
      }
      break;
    }
  }

  return Response.json({ ok: true });
}
