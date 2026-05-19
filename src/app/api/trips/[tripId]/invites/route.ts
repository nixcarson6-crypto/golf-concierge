import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { renderInviteEmail, sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ email: z.string().email() });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tripId: string }> },
) {
  const user = await requireUser();
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId, { minimumRole: "OWNER" });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const trip = access.trip;
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return new NextResponse("invalid email", { status: 400 });

  const email = body.data.email.toLowerCase();

  // Mark or upsert membership in PENDING state up front so the dashboard
  // reflects the invite immediately, even if email sending is async.
  await db.tripMember.upsert({
    where: { tripId_email: { tripId, email } },
    create: { tripId, email, role: "MEMBER" },
    update: {},
  });

  const inviteToken = nanoid(24);
  const invite = await db.tripInvite.create({
    data: {
      tripId,
      email,
      inviteToken,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
    },
  });

  const appUrl = env("NEXT_PUBLIC_APP_URL");
  const inviteUrl = `${appUrl}/invite/${inviteToken}`;
  const tmpl = renderInviteEmail({
    ownerName: user.name ?? "Your concierge",
    tripTitle: trip.title,
    destination: trip.destination,
    inviteUrl,
  });
  try {
    await sendEmail({ to: email, ...tmpl });
  } catch (err) {
    console.error("[invite email]", err);
  }

  return NextResponse.json({ ok: true, inviteId: invite.id, inviteUrl });
}
