/**
 * Adversarial proof of the browser-agent brain — the safety-critical
 * verification gate + the pure normalisers. Run with `pnpm check:brain`.
 *
 * Dependency-light, runner-free self-check (the repo has no test framework
 * yet; this mirrors the `check:env`/`check:places` convention). Every case
 * asserts the brain FAILS SAFE — it never upgrades to a customer-facing
 * "Booked ✓" without hard evidence. Re-run after any change to
 * outcome.ts / goal.ts / types.ts.
 */
import {
  verifyOutcome,
  cleanConfirmationCode,
  cleanEvidence,
  failureCopy,
  toBookingStatus,
  toConfirmationState,
  FAILURE_CODES,
  type RawBookingOutcome,
} from "./outcome";
import {
  buildBookingTask,
  toIsoDate,
  toDisplayTime,
  centsToUsd,
} from "./types";
import { buildGoal } from "./goal";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); console.error("  ✗ FAIL:", name); }
}

const raw = (o: Partial<RawBookingOutcome>): RawBookingOutcome => ({
  status: "confirmed", message: "", ...o,
});

/* ---- The anti-hallucination gate ---- */
check("hallucinated success (no code/evidence) -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed" })).status === "NEEDS_REVIEW");

check("valid order number -> CONFIRMED",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "118001" })).status === "CONFIRMED");

check("placeholder code 'confirmed' -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "Confirmed" })).status === "NEEDS_REVIEW");

check("placeholder code 'N/A' -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "N/A" })).status === "NEEDS_REVIEW");

check("placeholder code 'success' -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "success" })).status === "NEEDS_REVIEW");

check("placeholder code 'see email' -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "see email" })).status === "NEEDS_REVIEW");

check("evidence WITH a number -> CONFIRMED",
  verifyOutcome(raw({ status: "confirmed", confirmationEvidence: "Reservation confirmed for Aug 21 at 7:40 PM, party of 4" })).status === "CONFIRMED");

check("evidence pure prose (no number) -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationEvidence: "Your reservation is confirmed" })).status === "NEEDS_REVIEW");

check("short numeric code '12' alone -> NEEDS_REVIEW (too short)",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "12" })).status === "NEEDS_REVIEW");

check("short all-letters 'good' -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "good" })).status === "NEEDS_REVIEW");

check("long alnum no digit 'ABCDEF' -> CONFIRMED",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "ABCDEF" })).status === "CONFIRMED");

check("hashed code '#118001' -> CONFIRMED",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "#118001" })).status === "CONFIRMED");

/* ---- Contradictions ---- */
check("confirmed + failureReason set -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "118001", failureReason: "declined_card" })).status === "NEEDS_REVIEW");

check("FAILED but has valid code (probably booked) -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "failed", confirmationCode: "118001", failureReason: "ambiguous" })).status === "NEEDS_REVIEW");

/* ---- Budget ---- */
check("confirmed but materially over budget -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "confirmed", confirmationCode: "118001", amountChargedCents: 500000 }), { budgetCents: 300000 }).status === "NEEDS_REVIEW");

const slightlyOver = verifyOutcome(raw({ status: "confirmed", confirmationCode: "118001", amountChargedCents: 305000 }), { budgetCents: 300000 });
check("confirmed slightly over budget (tax) -> CONFIRMED but overBudget flag",
  slightlyOver.status === "CONFIRMED" && slightlyOver.overBudget === true);

/* ---- Failure paths ---- */
check("failed + reason -> FAILED w/ code",
  (() => { const v = verifyOutcome(raw({ status: "failed", failureReason: "no_availability" })); return v.status === "FAILED" && v.failureCode === "no_availability"; })());

check("failed, no reason -> FAILED ambiguous",
  (() => { const v = verifyOutcome(raw({ status: "failed" })); return v.status === "FAILED" && v.failureCode === "ambiguous"; })());

check("needs_review passthrough -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "needs_review", message: "unsure" })).status === "NEEDS_REVIEW");

check("garbage status -> NEEDS_REVIEW",
  verifyOutcome(raw({ status: "weird" as never })).status === "NEEDS_REVIEW");

/* ---- failureCopy always offers a real next step ---- */
for (const fc of FAILURE_CODES) {
  const c = failureCopy(fc, "La Fontelina");
  check(`failureCopy(${fc}) has message + showFallback`, c.message.length > 10 && c.showFallback === true);
}

/* ---- DB enum mapping ---- */
check("CONFIRMED -> booking CONFIRMED",
  toBookingStatus(verifyOutcome(raw({ status: "confirmed", confirmationCode: "118001" }))) === "CONFIRMED");
check("no_availability -> confirmationState UNAVAILABLE",
  toConfirmationState(verifyOutcome(raw({ status: "failed", failureReason: "no_availability" }))) === "UNAVAILABLE");
check("needs_review -> confirmationState HOLDING",
  toConfirmationState(verifyOutcome(raw({ status: "needs_review", message: "x" }))) === "HOLDING");

/* ---- validators ---- */
check("cleanConfirmationCode trims + accepts", cleanConfirmationCode("  ORD-99123 ") === "ORD-99123");
check("cleanConfirmationCode rejects empty", cleanConfirmationCode("   ") === null);
check("cleanConfirmationCode rejects null", cleanConfirmationCode(null) === null);
check("cleanEvidence rejects one word", cleanEvidence("confirmed") === null);
check("cleanEvidence accepts sentence", cleanEvidence("Order 118001 confirmed on screen") !== null);

/* ---- normalisers ---- */
check("toIsoDate UTC", toIsoDate(new Date("2026-08-21T19:40:00Z")) === "2026-08-21");
check("toDisplayTime midnight -> null", toDisplayTime(new Date("2026-08-21T00:00:00Z")) === null);
check("toDisplayTime 7:40pm", toDisplayTime(new Date("2026-08-21T19:40:00Z")) === "7:40 PM");
check("centsToUsd rounds", centsToUsd(305000) === 3050);
check("centsToUsd null", centsToUsd(null) === null);

const task = buildBookingTask({
  request: { tripId: "t", itineraryItemId: "i", type: "DINING", title: "Dinner at Lucibello", startTime: new Date("2026-08-21T19:40:00Z"), party: null, budget: 300000, location: "Positano" },
  traveler: { givenName: "Carson", familyName: "Nix", email: "c@x.com", phone: "+12125550100", partySize: 2 },
  venue: { name: "Lucibello", startUrl: "https://lucibello.it", phone: "+390812345", address: "Positano" },
});
check("buildBookingTask party fallback to traveler", task.traveler.partySize === 2);
check("buildBookingTask budget usd", task.budgetUsd === 3000);
check("buildBookingTask isoDate", task.isoDate === "2026-08-21");

const goal = buildGoal(task);
check("goal has system policy", goal.system.includes("NEVER claim success without proof"));
check("goal user msg has venue", goal.firstUserMessage.includes("Lucibello"));
check("goal user msg has budget", goal.firstUserMessage.includes("$3,000"));
check("goal user msg has traveler", goal.firstUserMessage.includes("Carson Nix"));
check("goal user msg has party", goal.firstUserMessage.includes("2 people"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("FAILED:", fails); process.exit(1); }
console.log("✓ ALL CHECKS PASSED — brain fails safe on every adversarial case.");
