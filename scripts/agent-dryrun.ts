#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * CLI dry-run for the browser-booking agent. Lets you point the agent at a
 * real venue URL from your terminal — without Stripe, without the rest of
 * the booking pipeline, without touching the UI.
 *
 *   pnpm check:agent --url "https://reserve.fontelina-capri.com/en" \
 *                    --venue "La Fontelina" \
 *                    --type DINING \
 *                    --party 2 \
 *                    --date 2026-08-21 \
 *                    --time "13:00" \
 *                    --budget 600
 *
 * Required: --url. Everything else has sensible defaults you can tweak.
 *
 * Streams live step labels to the terminal; on completion prints the verified
 * outcome from the skeptical brain gate + the live-view URL so you can see
 * what the agent did. Exits 0 on CONFIRMED, 1 on FAILED/NEEDS_REVIEW.
 *
 * No payment in the MVP path — the agent's request_payment_card returns
 * "unavailable" and the model gracefully reports needs_review on paid sites.
 * Use this against FREE-RESERVATION venues for the first real end-to-end test.
 */

import { runAgent, unavailableCardProvider } from "../src/lib/bookings/browser-agent/agent";
import { withSession, isBrowserbaseConfigured } from "../src/lib/bookings/browser-agent/runtime";
import { buildGoal } from "../src/lib/bookings/browser-agent/goal";
import { verifyOutcome } from "../src/lib/bookings/browser-agent/outcome";
import { buildBookingTask, type TravelerIdentity, type VenueTarget } from "../src/lib/bookings/browser-agent/types";
import type { BookingRequest } from "../src/lib/bookings/types";

type ItineraryItemType =
  | "TEE_TIME"
  | "LODGING"
  | "DINING"
  | "NIGHTLIFE"
  | "TRANSPORT"
  | "FLIGHT"
  | "FREE_TIME"
  | "SPA"
  | "ACTIVITY";

function arg(name: string, fallback?: string): string | undefined {
  const k = `--${name}`;
  const i = process.argv.indexOf(k);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const url = arg("url");
  if (!url) {
    console.error(
      "ERROR: --url is required.\n" +
        "  pnpm check:agent --url https://example.com/reserve --venue Example --type DINING --party 2 --date 2026-08-21 --time 13:00 --budget 600",
    );
    process.exit(2);
  }
  if (!isBrowserbaseConfigured()) {
    console.error(
      "ERROR: BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set in .env.local.\n" +
        "       Run `pnpm check:env` to verify.",
    );
    process.exit(2);
  }

  const venueName = arg("venue", "Test venue")!;
  const type = (arg("type", "DINING") as ItineraryItemType) ?? "DINING";
  const party = Number(arg("party", "2"));
  const date = arg("date") ?? null; // YYYY-MM-DD
  const time = arg("time") ?? null; // HH:MM 24-hour, venue-local intent
  const budgetUsd = Number(arg("budget", "0")); // 0 = unbudgeted

  const startTime = (() => {
    if (!date) return null;
    const hhmm = time ?? "12:00";
    const iso = `${date}T${hhmm.length === 5 ? hhmm : "12:00"}:00Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  })();

  const traveler: TravelerIdentity = {
    givenName: arg("given-name", "Carson")!,
    familyName: arg("family-name", "Nix")!,
    email: arg("email", "nixcarson6@gmail.com")!,
    phone: arg("phone", "+12025550100")!,
    dateOfBirth: arg("dob") ?? null,
    partySize: Number.isFinite(party) && party >= 1 ? party : 1,
  };

  const venue: VenueTarget = {
    name: venueName,
    startUrl: url,
    address: arg("address") ?? null,
    phone: arg("venue-phone") ?? null,
  };

  const request: BookingRequest = {
    tripId: "dryrun",
    itineraryItemId: "dryrun",
    type,
    title: arg("title", `${venueName} reservation`)!,
    startTime,
    endTime: null,
    party: traveler.partySize,
    budget: budgetUsd > 0 ? Math.round(budgetUsd * 100) : null,
    location: venue.address ?? null,
    metadata: {},
  };

  // SAFETY: default to dry-run (fill the form, stop before final submit) so
  // testing against real venues never sends them a junk reservation. Pass
  // --submit ONLY when there's genuine booking intent.
  const reallySubmit = process.argv.includes("--submit");
  const task = buildBookingTask({ request, traveler, venue });
  const goal = buildGoal(task, { dryRun: !reallySubmit });

  console.log("─".repeat(72));
  console.log(`Agent dry-run → ${venueName}`);
  console.log(`URL:      ${url}`);
  console.log(`Type:     ${type}`);
  console.log(
    `When:     ${task.displayDate ?? "no-date"}${task.displayTime ? ` at ${task.displayTime}` : ""}`,
  );
  console.log(`Party:    ${traveler.partySize}`);
  console.log(`Budget:   ${task.budgetUsd ? `$${task.budgetUsd}` : "none"}`);
  console.log(`Traveler: ${traveler.givenName} ${traveler.familyName} <${traveler.email}>`);
  console.log(
    reallySubmit
      ? "Mode:     ⚠️  LIVE — the agent WILL submit a real reservation."
      : "Mode:     🧪 TEST — fills the form, stops before final submit (no real reservation).",
  );
  console.log("─".repeat(72));
  console.log("Opening Browserbase session…");

  const started = Date.now();
  let result;
  try {
    result = await withSession(async (session) => {
      console.log(`Session id:    ${session.sessionId}`);
      if (session.liveViewUrl) {
        console.log(`Live view:     ${session.liveViewUrl}`);
        console.log("              (open in a browser to watch the agent work)");
      }
      console.log("─".repeat(72));
      return runAgent({
        page: session.page,
        system: goal.system,
        firstUserMessage: goal.firstUserMessage,
        cardProvider: unavailableCardProvider,
        onStep: ({ iteration, label }) => {
          console.log(`  [${String(iteration).padStart(2, " ")}] ${label}`);
        },
      });
    });
  } catch (err) {
    console.error("\nFATAL — session/runtime failed:");
    console.error(err instanceof Error ? `  ${err.message}` : err);
    process.exit(1);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("─".repeat(72));
  console.log(`Loop done in ${elapsed}s · ${result.iterations} iterations · ${result.inputTokensUsed} in / ${result.outputTokensUsed} out tokens`);
  console.log("─".repeat(72));
  console.log("Raw agent outcome:");
  console.log(JSON.stringify(result.outcome, null, 2));

  const verified = verifyOutcome(result.outcome, { budgetCents: task.budgetCents, venueName });
  console.log("─".repeat(72));
  console.log(`Verified status: ${verified.status}`);
  if (verified.confirmationCode) console.log(`Confirmation:    ${verified.confirmationCode}`);
  if (verified.evidence) console.log(`Evidence:        ${verified.evidence}`);
  if (verified.amountChargedCents) console.log(`Charged:         $${(verified.amountChargedCents / 100).toFixed(2)}`);
  if (verified.failureCode) console.log(`Failure code:    ${verified.failureCode}`);
  if (verified.reviewReason) console.log(`Review reason:   ${verified.reviewReason}`);
  console.log(`Customer copy:   ${verified.customerMessage}`);
  if (verified.showFallback) console.log("(Fallback website/phone buttons would render in the UI.)");
  console.log("─".repeat(72));

  if (verified.status === "CONFIRMED") {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

void main();
