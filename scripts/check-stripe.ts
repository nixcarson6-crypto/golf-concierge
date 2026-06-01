#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Stripe payment-engine smoke test — proves the money plumbing works in
 * TEST mode, no Anthropic credits and no frontend required.
 *
 *   pnpm check:stripe
 *
 * Exercises, end to end, the exact calls the booking flow makes:
 *   1. Issuing balance check (are there test funds to authorize against?)
 *   2. Create an Issuing cardholder
 *   3. Mint a single-use virtual card with a $X per-authorization limit
 *   4. Reveal the PAN/exp/CVC (what we hand the agent at checkout)
 *   5. Charge a test card via PaymentIntent (the customer → Pyltrix leg)
 *   6. Clean up (cancel the virtual card)
 *
 * If all six pass, the payment engine is wired correctly; the only thing
 * left for live booking is the agent (Anthropic credits) + the webhook
 * tunnel (Stripe CLI) to exercise the real-time authorization control.
 */

import { stripe, stripeConfigured } from "../src/lib/stripe";
import {
  createSingleUseCard,
  revealCard,
  cancelCard,
  issuingBalanceCents,
} from "../src/lib/payments/issuing";

async function main(): Promise<void> {
  console.log("─".repeat(64));
  console.log("Stripe payment-engine smoke test (TEST mode)");
  console.log("─".repeat(64));

  if (!stripeConfigured()) {
    console.error("✗ STRIPE_SECRET_KEY is not set. Add it to .env.local.");
    process.exit(2);
  }
  const sk = stripe();

  let cardId: string | null = null;
  let ok = true;
  const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`);

  try {
    // 1. Issuing balance
    step(1, "Issuing balance");
    const bal = await issuingBalanceCents();
    if (bal == null) {
      console.log("   ⚠️  Could not read Issuing balance (Issuing may not be enabled).");
    } else {
      console.log(`   Available: $${(bal / 100).toFixed(2)}`);
      if (bal <= 0) {
        console.log("   ⚠️  $0 — add test funds: Dashboard → Issuing → Add funds.");
        console.log("       (Cards will mint but authorizations will decline with no balance.)");
      }
    }

    // 2. Cardholder
    step(2, "Create Issuing cardholder");
    const cardholder = await sk.issuing.cardholders.create({
      type: "individual",
      name: "Pyltrix Test Traveler",
      email: "test@pyltrix.com",
      phone_number: "+12125550100",
      billing: {
        address: {
          line1: "1 Market St",
          city: "San Francisco",
          state: "CA",
          postal_code: "94105",
          country: "US",
        },
      },
    });
    console.log(`   ✓ cardholder ${cardholder.id}`);

    // 3. Mint single-use virtual card ($300 limit)
    step(3, "Mint single-use virtual card ($300 per-authorization limit)");
    cardId = await createSingleUseCard({
      cardholderId: cardholder.id,
      amountCents: 30000,
      bookingId: "smoke-test",
    });
    console.log(`   ✓ card ${cardId}`);

    // 4. Reveal PAN
    step(4, "Reveal card number (what the agent types at checkout)");
    const revealed = await revealCard(cardId);
    const masked = `${revealed.number.slice(0, 4)} **** **** ${revealed.number.slice(-4)}`;
    console.log(`   ✓ ${masked}  exp ${String(revealed.expMonth).padStart(2, "0")}/${revealed.expYear}  cvc ***`);
    console.log("     (full PAN retrieved successfully — not logged)");

    // 5. Charge a test card (customer → Pyltrix leg)
    step(5, "Charge a test card via PaymentIntent ($315 = $300 + $15 fee)");
    const pi = await sk.paymentIntents.create({
      amount: 31500,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
      description: "Pyltrix smoke-test charge",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    });
    console.log(`   ✓ PaymentIntent ${pi.id} → ${pi.status}`);
    if (pi.status !== "succeeded") {
      console.log(`   ⚠️  Expected 'succeeded', got '${pi.status}'.`);
      ok = false;
    }
  } catch (err) {
    ok = false;
    console.error("\n✗ FAILED:", err instanceof Error ? err.message : err);
  } finally {
    // 6. Cleanup
    if (cardId) {
      await cancelCard(cardId);
      console.log(`\n[6] Cleanup → cancelled card ${cardId}`);
    }
  }

  console.log("\n" + "─".repeat(64));
  if (ok) {
    console.log("✓ Payment engine works: cardholder + single-use card + reveal + charge.");
    console.log("  Next: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`");
    console.log("  then `stripe trigger issuing_authorization.request` to test the");
    console.log("  real-time approval control.");
    process.exit(0);
  } else {
    console.log("✗ Something failed above — see the error. Common causes:");
    console.log("  • Issuing not enabled on the account (Dashboard → Issuing → Get started)");
    console.log("  • No test funds (Dashboard → Issuing → Add funds)");
    process.exit(1);
  }
}

main();
