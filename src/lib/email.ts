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
  <body style="margin:0;padding:0;background:#f5f5f5;">
    ${args.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(args.preheader)}</div>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e6e6e6;border-radius:18px;overflow:hidden;">
          <tr><td style="padding:28px 32px 0;">
            <span style="font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:20px;letter-spacing:-0.02em;color:#0a0a0a;">Pyltrix</span>
          </td></tr>
          <tr><td style="padding:20px 32px 32px;">
            ${args.bodyHtml}
          </td></tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:12px;color:#8a8a8a;line-height:1.5;">
              Pyltrix — AI luxury golf-travel concierge · <a href="https://pyltrix.com" style="color:#8a8a8a;">pyltrix.com</a>
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();
}

function button(href: string, label: string) {
  return `<a href="${href}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:12px;font-family:Inter,Arial,sans-serif;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>`;
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
          You're in. Answer a few quick questions and our AI builds a complete luxury golf trip — flights, lodging, tee times, dining, and transport — then books the whole thing for you. You just show up.
        </p>
        ${button(args.appUrl, "Plan my first trip")}
        <p style="font-family:Inter,Arial,sans-serif;font-size:13px;color:#8a8a8a;line-height:1.6;margin:26px 0 0;">
          Questions? Just reply to this email — it reaches us directly.
        </p>
      `.trim(),
    }),
    text: `${args.name ? `Welcome, ${args.name.split(" ")[0]}` : "Welcome to Pyltrix"}.\n\nAnswer a few quick questions and our AI builds a complete luxury golf trip — flights, lodging, tee times, dining, transport — then books it for you.\n\nPlan your first trip: ${args.appUrl}`,
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
      ? `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#0a0a0a;background:#f5f5f5;border-radius:6px;padding:3px 8px;white-space:nowrap;">${escapeHtml(l.confirmationCode)}</span>`
      : "";
    const settle =
      l.paymentMode === "pay_at_property"
        ? `<div style="font-family:Inter,Arial,sans-serif;font-size:11px;color:#8a8a8a;margin-top:3px;">Settles at the property</div>`
        : "";
    return `
      <tr>
        <td style="padding:13px 0;border-bottom:1px solid #f0f0f0;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;color:#0a0a0a;">${escapeHtml(l.title)}</div>
          ${l.detail ? `<div style="font-family:Inter,Arial,sans-serif;font-size:12.5px;color:#8a8a8a;margin-top:2px;">${escapeHtml(l.detail)}</div>` : ""}
          ${settle}
        </td>
        <td align="right" style="padding:13px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">${code}</td>
      </tr>`;
  };

  return {
    subject: `You're booked — ${args.tripLabel}`,
    html: shell({
      preheader: `Your trip to ${args.tripLabel} is booked. Here are your confirmations.`,
      bodyHtml: `
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:26px;letter-spacing:-0.02em;color:#0a0a0a;margin:8px 0 14px;line-height:1.15;">${firstName ? `${escapeHtml(firstName)}, you&apos;re booked.` : "You&apos;re booked."}</h1>
        <p style="font-family:Inter,Arial,sans-serif;font-size:15px;color:#525252;line-height:1.6;margin:0 0 22px;">
          Your trip to <strong style="color:#0a0a0a;">${escapeHtml(args.tripLabel)}</strong> is confirmed. Every reservation below is real — venues hold them under your name, and they'll email you their own confirmations too.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #e6e6e6;">
          ${args.lines.map(row).join("")}
        </table>
        ${button(args.tripUrl, "View your trip")}
        <p style="font-family:Inter,Arial,sans-serif;font-size:13px;color:#8a8a8a;line-height:1.6;margin:26px 0 0;">
          Need a change? Reply to this email and we'll handle it.
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
