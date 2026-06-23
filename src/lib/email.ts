import { Resend } from "resend";
import { env, optionalEnv } from "./env";

let _resend: Resend | null = null;

function resend() {
  if (_resend) return _resend;
  _resend = new Resend(optionalEnv("RESEND_API_KEY") || "re_unset");
  return _resend;
}

export async function sendEmail(args: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}) {
  if (!optionalEnv("RESEND_API_KEY")) {
    // Quietly no-op in dev when no Resend key — log so devs see it.
    console.warn(`[email] skipped (no RESEND_API_KEY): ${args.subject} → ${args.to}`);
    return { id: "skipped" } as const;
  }
  return resend().emails.send({
    from: env("RESEND_FROM_EMAIL"),
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
    replyTo: args.replyTo,
  });
}

export function renderInviteEmail(args: {
  ownerName: string;
  tripTitle: string;
  destination?: string | null;
  inviteUrl: string;
}) {
  const where = args.destination ? `to <strong>${escapeHtml(args.destination)}</strong>` : "";
  return {
    subject: `${args.ownerName} invited you to a golf trip${args.destination ? ` to ${args.destination}` : ""}`,
    html: `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0a0a0c;color:#f1ece1;">
        <h1 style="font-family:'Fraunces',Georgia,serif;font-weight:500;letter-spacing:-0.01em;margin:0 0 8px;">${escapeHtml(args.ownerName)} invited you to a trip${args.destination ? `, ${where}` : ""}.</h1>
        <p style="color:#bdb7a8;line-height:1.6;margin:0 0 24px;">${escapeHtml(args.tripTitle)}</p>
        <a href="${args.inviteUrl}" style="display:inline-block;background:#d6b274;color:#15110a;text-decoration:none;padding:14px 22px;border-radius:14px;font-weight:600;">View the trip</a>
        <p style="color:#8a8576;font-size:13px;margin-top:32px;">If you weren't expecting this, you can ignore this email.</p>
      </div>
    `.trim(),
    text: `${args.ownerName} invited you to "${args.tripTitle}". Open: ${args.inviteUrl}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Brand shell — monochrome, matches the pyltrix.com landing (Fraunces display, */
/* black ink on white). All inline styles so it renders in every mail client.   */
/* -------------------------------------------------------------------------- */

function shell(args: { preheader?: string; bodyHtml: string }) {
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#EFECE3;-webkit-font-smoothing:antialiased;">
    ${args.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(args.preheader)}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFECE3;padding:36px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFDF8;border:1px solid #E3E0D5;border-radius:20px;overflow:hidden;">
          <tr><td style="padding:30px 36px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="vertical-align:middle;">
                <span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;background:#1E4030;border-radius:9px;color:#F6F4EE;font-size:15px;">&#10022;</span>
              </td>
              <td style="vertical-align:middle;padding-left:10px;">
                <span style="font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:21px;letter-spacing:-0.01em;color:#16150F;">Pyltrix</span>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:22px 36px 34px;">
            ${args.bodyHtml}
          </td></tr>
          <tr><td style="padding:22px 36px;border-top:1px solid #EFECE3;background:#F6F4EE;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6658;line-height:1.7;">
              Pyltrix — AI luxury golf-travel concierge<br>
              <a href="https://pyltrix.com" style="color:#1E4030;text-decoration:none;">pyltrix.com</a> &nbsp;&middot;&nbsp; <a href="mailto:support@pyltrix.com" style="color:#1E4030;text-decoration:none;">support@pyltrix.com</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();
}

function button(href: string, label: string) {
  return `<a href="${href}" style="display:inline-block;background:#1E4030;color:#F6F4EE;text-decoration:none;padding:14px 26px;border-radius:13px;font-family:Arial,Helvetica,sans-serif;font-weight:600;font-size:14px;letter-spacing:0.01em;">${escapeHtml(label)}</a>`;
}

/**
 * Welcome email — fired the first time a user signs up (Clerk user.created).
 * Warm, short, points them at building their first trip.
 */
export function renderWelcomeEmail(args: { name?: string | null; appUrl: string }) {
  const greeting = args.name ? `Welcome, ${escapeHtml(args.name.split(" ")[0])}` : "Welcome to Pyltrix";
  return {
    subject: "Welcome to Pyltrix",
    html: shell({
      preheader: "Answer a few questions and we'll build your whole golf trip — then book it.",
      bodyHtml: `
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:26px;letter-spacing:-0.02em;color:#0a0a0a;margin:8px 0 14px;line-height:1.15;">${greeting}.</h1>
        <p style="font-family:Inter,Arial,sans-serif;font-size:15px;color:#525252;line-height:1.6;margin:0 0 22px;">
          You're in. Answer a few quick questions and our AI designs a complete luxury golf trip — flights, lodging, tee times, dining, and transport — at real prices. We book your flights and your stay, you pick your tee times, and we line up the rest.
        </p>
        ${button(args.appUrl, "Plan my first trip")}
        <p style="font-family:Inter,Arial,sans-serif;font-size:13px;color:#8a8a8a;line-height:1.6;margin:26px 0 0;">
          Questions? Just reply to this email — it reaches us directly.
        </p>
      `.trim(),
    }),
    text: `${args.name ? `Welcome, ${args.name.split(" ")[0]}` : "Welcome to Pyltrix"}.\n\nAnswer a few quick questions and our AI designs a complete luxury golf trip — flights, lodging, tee times, dining, transport — at real prices. We book your flights and stay, you pick your tee times, and we line up the rest.\n\nPlan your first trip: ${args.appUrl}`,
  };
}

export type ConfirmationLine = {
  title: string;
  detail?: string | null;
  confirmationCode?: string | null;
  /** "pay_now" = already charged; "pay_at_property" = settle at the venue. */
  paymentMode?: "pay_now" | "pay_at_property" | null;
};

/**
 * Booking-confirmation email — the product's payoff. Sent after Book All so
 * the customer gets the itinerary + every confirmation code in one place.
 * Splits "confirmed" lines from "settles at the property" so expectations are
 * honest. Skips items with nothing booked.
 */
export function renderBookingConfirmationEmail(args: {
  name?: string | null;
  tripLabel: string;
  lines: ConfirmationLine[];
  tripUrl: string;
}) {
  const firstName = args.name ? args.name.split(" ")[0] : null;
  const row = (l: ConfirmationLine) => {
    const code = l.confirmationCode
      ? `<span style="display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#1E4030;background:#EAF0EC;border:1px solid #D5E0D8;border-radius:7px;padding:4px 9px;white-space:nowrap;">${escapeHtml(l.confirmationCode)}</span>`
      : `<span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8576;">Saved on your trip</span>`;
    const settle =
      l.paymentMode === "pay_at_property"
        ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8a8576;margin-top:3px;">Settles at the property</div>`
        : "";
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #EFECE3;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#16150F;">${escapeHtml(l.title)}</div>
          ${l.detail ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#8a8576;margin-top:2px;">${escapeHtml(l.detail)}</div>` : ""}
          ${settle}
        </td>
        <td align="right" style="padding:14px 16px;border-bottom:1px solid #EFECE3;vertical-align:top;">${code}</td>
      </tr>`;
  };

  return {
    subject: `You're booked — ${args.tripLabel}`,
    html: shell({
      preheader: `Your trip to ${args.tripLabel} is booked. Here are your confirmations.`,
      bodyHtml: `
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#1E4030;margin:6px 0 10px;">Your trip is confirmed</p>
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:28px;letter-spacing:-0.02em;color:#16150F;margin:0 0 14px;line-height:1.12;">${firstName ? `${escapeHtml(firstName)}, you&apos;re booked.` : "You&apos;re booked."}</h1>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#57534a;line-height:1.6;margin:0 0 24px;">
          Your trip to <strong style="color:#16150F;">${escapeHtml(args.tripLabel)}</strong> is set. Every reservation below is held under your name — keep this email as your record, with the confirmation numbers you'll need.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 26px;border:1px solid #E3E0D5;border-radius:14px;overflow:hidden;">
          ${args.lines.map(row).join("")}
        </table>
        ${button(args.tripUrl, "View your trip")}
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8a8576;line-height:1.6;margin:26px 0 0;">
          Need a change? Just reply — it reaches us at support@pyltrix.com.
        </p>
      `.trim(),
    }),
    text:
      `${firstName ? `${firstName}, you're booked.` : "You're booked."}\n\n` +
      `Your trip to ${args.tripLabel} is confirmed.\n\n` +
      args.lines
        .map(
          (l) =>
            `• ${l.title}${l.confirmationCode ? ` — ${l.confirmationCode}` : ""}${l.paymentMode === "pay_at_property" ? " (settles at the property)" : ""}`,
        )
        .join("\n") +
      `\n\nView your trip: ${args.tripUrl}`,
  };
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
