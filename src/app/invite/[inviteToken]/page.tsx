import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getOrCreateUser } from "@/lib/auth";
import { welcomeMember } from "@/lib/ai/agents/memberOnboarding";

export const dynamic = "force-dynamic";

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ inviteToken: string }>;
}) {
  const { inviteToken } = await params;
  const invite = await db.tripInvite.findUnique({
    where: { inviteToken },
    include: { trip: true },
  });
  if (!invite || invite.status !== "PENDING" || invite.expiresAt < new Date()) {
    notFound();
  }

  const user = await getOrCreateUser();
  if (!user) {
    redirect(`/sign-in?redirect_url=/invite/${inviteToken}`);
  }

  const [member] = await db.$transaction([
    db.tripMember.upsert({
      where: { tripId_email: { tripId: invite.tripId, email: invite.email } },
      create: {
        tripId: invite.tripId,
        email: invite.email,
        userId: user.id,
        name: user.name,
        role: "MEMBER",
        joinedAt: new Date(),
      },
      update: {
        userId: user.id,
        name: user.name,
        joinedAt: new Date(),
      },
    }),
    db.tripInvite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED" },
    }),
  ]);

  // Conversational onboarding — fire & forget so the redirect is instant and
  // the welcome message is already in the chat when they arrive.
  void welcomeMember({
    tripId: invite.tripId,
    memberId: member.id,
    memberName: user.name,
    memberEmail: user.email,
  }).catch((err) => console.error("[member welcome]", err));

  redirect(`/trips/${invite.tripId}`);
}
