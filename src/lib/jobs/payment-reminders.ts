import { db } from "../db";
import { renderInviteEmail, sendEmail } from "../email";
import { pushToUser } from "../push";
import { env } from "../env";

/**
 * Daily payment dunning sweep. For every BOOKED-or-BOOKING trip with members
 * who still haven't paid in 48h+, send a gentle nudge — email + push (when
 * subscribed). Caps per member at 3 reminders, 48h apart, then stops.
 */
export async function runPaymentReminders() {
  const trips = await db.trip.findMany({
    where: { status: { in: ["BOOKING", "BOOKED"] } },
    include: {
      members: { include: { payments: true, user: true } },
    },
  });
  const appUrl = env("NEXT_PUBLIC_APP_URL");
  let sent = 0;

  for (const trip of trips) {
    for (const m of trip.members) {
      if (m.paymentStatus === "PAID" || m.paymentStatus === "REFUNDED") continue;
      const latestPaymentLink = m.payments
        .filter((p) => p.metadata && (p.metadata as { url?: string }).url)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!latestPaymentLink) continue;

      const lastReminderAt = m.payments
        .map((p) => (p.metadata as { lastReminderAt?: string } | null)?.lastReminderAt)
        .filter(Boolean)
        .sort()
        .pop();
      if (lastReminderAt) {
        const ageHours =
          (Date.now() - new Date(lastReminderAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 48) continue;
      } else {
        const ageHours =
          (Date.now() - latestPaymentLink.createdAt.getTime()) / (1000 * 60 * 60);
        if (ageHours < 48) continue;
      }
      const reminderCount =
        ((latestPaymentLink.metadata as { reminderCount?: number } | null)
          ?.reminderCount) ?? 0;
      if (reminderCount >= 3) continue;

      const url = (latestPaymentLink.metadata as { url?: string }).url!;
      const tpl = renderInviteEmail({
        ownerName: "Your concierge",
        tripTitle: `Friendly reminder — ${trip.title}`,
        destination: trip.destination,
        inviteUrl: url,
      });
      try {
        await sendEmail({
          to: m.email,
          subject: `Quick nudge: your share of ${trip.title}`,
          html: tpl.html.replace("View the trip", "Settle up — 30 seconds"),
        });
        sent++;
      } catch (err) {
        console.error("[payment reminder email]", err);
      }
      if (m.userId) {
        await pushToUser({
          userId: m.userId,
          title: `Quick nudge on ${trip.title}`,
          body: "Your share is still open — open the trip when you've got a sec.",
          url: `/trips/${trip.id}/payments`,
        }).catch(() => {});
      }

      await db.payment.update({
        where: { id: latestPaymentLink.id },
        data: {
          metadata: {
            ...(latestPaymentLink.metadata as object | null),
            reminderCount: reminderCount + 1,
            lastReminderAt: new Date().toISOString(),
          },
        },
      });
    }
  }
  return { sent };
}
