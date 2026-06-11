/**
 * Verify Resend email works end-to-end.
 *
 *   pnpm check:email                 # sends to nixcarson6@gmail.com
 *   pnpm check:email you@email.com   # sends to a specific address
 *
 * Sends BOTH templates the app uses — the welcome email and a sample
 * booking-confirmation — so you can eyeball how they render in a real inbox.
 *
 * NOTE: the default sender (onboarding@resend.dev) only delivers to the
 * email on your own Resend account. Once pyltrix.com is verified in Resend,
 * set RESEND_FROM_EMAIL="Pyltrix <hello@pyltrix.com>" and it can mail anyone.
 */

import { optionalEnv } from "../src/lib/env";
import {
  sendEmail,
  renderWelcomeEmail,
  renderBookingConfirmationEmail,
} from "../src/lib/email";

async function main() {
  const to = process.argv[2] || "nixcarson6@gmail.com";
  if (!optionalEnv("RESEND_API_KEY")) {
    console.error("✗ RESEND_API_KEY not found in .env.local");
    console.error("  Sign up at resend.com, copy the API key, add it as");
    console.error("  RESEND_API_KEY=re_... in .env.local, then re-run.");
    process.exit(1);
  }
  console.log(`✓ RESEND_API_KEY detected. Sending two test emails to ${to}…\n`);

  // 1) Welcome
  console.log("1) Welcome email…");
  const welcome = renderWelcomeEmail({
    name: "Carson Nix",
    appUrl: "https://pyltrix.com/trips/new",
  });
  const r1 = await sendEmail({
    to,
    subject: welcome.subject,
    html: welcome.html,
    text: welcome.text,
  });
  console.log(`   ✓ sent (id: ${"id" in r1 ? r1.id : "?"})`);

  // 2) Booking confirmation
  console.log("2) Booking-confirmation email…");
  const confirm = renderBookingConfirmationEmail({
    name: "Carson Nix",
    tripLabel: "Pinehurst",
    lines: [
      {
        title: "American · DFW ⇄ RDU",
        detail: "$2,840 total",
        confirmationCode: "AA-7F3KQ2",
        paymentMode: "pay_now",
      },
      {
        title: "Pinehurst No. 2 · championship round",
        detail: "Sunday tee time, 8:50 AM",
        confirmationCode: "PH2-88341",
        paymentMode: "pay_at_property",
      },
      {
        title: "The Carolina Hotel · 4 nights",
        detail: "Suite",
        confirmationCode: "CH-220194",
        paymentMode: "pay_at_property",
      },
    ],
    tripUrl: "https://pyltrix.com/trips/demo",
  });
  const r2 = await sendEmail({
    to,
    subject: confirm.subject,
    html: confirm.html,
    text: confirm.text,
  });
  console.log(`   ✓ sent (id: ${"id" in r2 ? r2.id : "?"})`);

  console.log(
    `\n🎉 Both emails sent. Check ${to} (and the spam folder the first time).`,
  );
  console.log(
    "If they landed, the welcome + booking-confirmation flows are live.",
  );
}

main().catch((e) => {
  console.error(`\n✗ Email send failed: ${(e as Error).message}`);
  console.error(
    "  Common causes: key typo, or the default onboarding@resend.dev sender",
  );
  console.error(
    "  only mails YOUR Resend account address until pyltrix.com is verified.",
  );
  process.exit(1);
});
