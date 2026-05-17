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

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
