/**
 * The booking-outcome contract + the skeptical verification gate.
 *
 * This is the safety-critical heart of the browser agent. The cardinal rule
 * (CLAUDE.md): "fails visibly, never silently." A customer must NEVER be told
 * "Booked ✓" unless there is hard, on-screen evidence the vendor actually
 * confirmed the reservation. So `verifyOutcome` is skeptical by default —
 * it assumes the booking did NOT happen and only upgrades to CONFIRMED when
 * the agent produced a real confirmation code or concrete confirmation
 * evidence, and downgrades anything contradictory / over-budget / unproven
 * to NEEDS_REVIEW (a human glances before we charge or claim success).
 *
 * Pure logic — no Browserbase/Stripe/Anthropic deps. Fully unit-testable.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* The contract the agent's `report_outcome` tool must satisfy                 */
/* -------------------------------------------------------------------------- */

export const FAILURE_CODES = [
  "declined_card", // vendor checkout rejected the (virtual) card
  "no_availability", // requested date/time/party not bookable
  "captcha_blocked", // unsolvable CAPTCHA / bot wall
  "login_required", // mandatory account login we don't have
  "form_not_found", // no online booking form (phone/email-only venue)
  "budget_exceeded", // real price came in over the budget ceiling
  "ambiguous", // can't safely tell what state the booking is in
  "timeout", // ran out of time / iterations
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export const failureCodeSchema = z.enum(FAILURE_CODES);

/** What the model returns when it calls `report_outcome`. */
export const bookingOutcomeSchema = z.object({
  status: z.enum(["confirmed", "failed", "needs_review"]),
  /** The exact confirmation / order / reservation number shown on screen. */
  confirmationCode: z.string().nullish(),
  /** A short quote of the on-screen confirmation text, as concrete evidence. */
  confirmationEvidence: z.string().nullish(),
  /** Total actually charged, in cents, if a payment was made. */
  amountChargedCents: z.number().nullish(),
  /** Required when status is "failed". */
  failureReason: failureCodeSchema.nullish(),
  /** One-sentence human summary of what happened. */
  message: z.string().default(""),
});

export type RawBookingOutcome = z.infer<typeof bookingOutcomeSchema>;

/**
 * Hand-written JSON Schema for the Anthropic `report_outcome` tool input.
 * Kept in lockstep with `bookingOutcomeSchema` above. (agent.ts assembles the
 * tool; we expose the schema here so the contract lives with its verifier.)
 */
export const reportOutcomeToolInputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["confirmed", "failed", "needs_review"],
      description:
        "confirmed ONLY if the vendor showed a confirmation/order/reservation number or an explicit 'your reservation is confirmed' page. failed if you could not book. needs_review if you are unsure whether it went through.",
    },
    confirmationCode: {
      type: "string",
      description:
        "The exact confirmation / order / reservation number shown on the page. Leave empty if there isn't one.",
    },
    confirmationEvidence: {
      type: "string",
      description:
        "A short verbatim quote of the on-screen confirmation text (e.g. 'Order #118001 — confirmed for Aug 21, 7:40 PM, party of 4').",
    },
    amountChargedCents: {
      type: "integer",
      description: "Total actually charged, in cents, if you completed payment.",
    },
    failureReason: {
      type: "string",
      enum: FAILURE_CODES,
      description: "Required when status is 'failed'. The specific reason.",
    },
    message: {
      type: "string",
      description: "One-sentence summary of exactly what happened.",
    },
  },
  required: ["status", "message"],
} as const;

/* -------------------------------------------------------------------------- */
/* The verification gate                                                        */
/* -------------------------------------------------------------------------- */

export type VerifiedStatus = "CONFIRMED" | "FAILED" | "NEEDS_REVIEW";

export type VerifiedOutcome = {
  status: VerifiedStatus;
  confirmationCode: string | null;
  evidence: string | null;
  amountChargedCents: number | null;
  failureCode: FailureCode | null;
  /** True when the charged amount exceeded the budget ceiling at all. */
  overBudget: boolean;
  /** Why we downgraded / flagged (audit + logs; not shown to customer). */
  reviewReason: string | null;
  /** Customer-facing one-liner. */
  customerMessage: string;
  /** Whether the UI should surface the website/phone manual fallback. */
  showFallback: boolean;
};

export type VerifyContext = {
  /** Hard budget ceiling in cents, or null if unknown. */
  budgetCents?: number | null;
  /** Venue name, for nicer customer copy. */
  venueName?: string | null;
};

/**
 * Run the skeptical gate over the agent's self-reported outcome.
 *
 * Decision policy (skeptical-by-default):
 *  - "confirmed" is honoured ONLY with a valid confirmation code OR concrete
 *    evidence (containing a number). Bare prose / nothing → NEEDS_REVIEW.
 *  - "confirmed" but materially over budget → NEEDS_REVIEW (never silently
 *    accept an overcharge).
 *  - "confirmed" but also carrying a failureReason → contradiction →
 *    NEEDS_REVIEW.
 *  - "failed" but carrying a valid confirmation code → it probably DID book;
 *    never tell the customer "failed" when they may hold a reservation →
 *    NEEDS_REVIEW.
 *  - Missing / unparseable status → NEEDS_REVIEW.
 */
export function verifyOutcome(
  raw: RawBookingOutcome,
  ctx: VerifyContext = {},
): VerifiedOutcome {
  const code = cleanConfirmationCode(raw.confirmationCode);
  const evidence = cleanEvidence(raw.confirmationEvidence);
  const amount =
    typeof raw.amountChargedCents === "number" &&
    Number.isFinite(raw.amountChargedCents) &&
    raw.amountChargedCents >= 0
      ? Math.round(raw.amountChargedCents)
      : null;
  const failureCode = raw.failureReason ?? null;
  const budget =
    typeof ctx.budgetCents === "number" && ctx.budgetCents > 0
      ? ctx.budgetCents
      : null;

  const hasValidCode = code !== null;
  const hasConcreteEvidence = evidence !== null && /\d/.test(evidence);
  const overBudget = budget !== null && amount !== null && amount > budget;
  const materiallyOver =
    budget !== null &&
    amount !== null &&
    amount > Math.max(budget * 1.15, budget + 2000); // >15% or >$20 over

  const base = {
    confirmationCode: code,
    evidence,
    amountChargedCents: amount,
    failureCode,
    overBudget,
  };

  const review = (reason: string): VerifiedOutcome => ({
    ...base,
    status: "NEEDS_REVIEW",
    reviewReason: reason,
    customerMessage:
      "We're double-checking this booking before we confirm it — hang tight, we'll update you shortly.",
    showFallback: false,
  });

  const fail = (fc: FailureCode): VerifiedOutcome => {
    const copy = failureCopy(fc, ctx.venueName ?? null);
    return {
      ...base,
      status: "FAILED",
      failureCode: fc,
      reviewReason: null,
      customerMessage: copy.message,
      showFallback: copy.showFallback,
    };
  };

  // --- Unparseable / missing status -> never trust it.
  if (raw.status !== "confirmed" && raw.status !== "failed" && raw.status !== "needs_review") {
    return review("Agent returned an unrecognised status.");
  }

  // --- Explicit needs_review from the agent.
  if (raw.status === "needs_review") {
    return review(raw.message?.slice(0, 240) || "Agent was unsure the booking completed.");
  }

  // --- "failed" but it looks like it actually booked -> review, don't claim failure.
  if (raw.status === "failed") {
    if (hasValidCode) {
      return review(
        `Agent reported failure but produced a confirmation code (${code}) — verifying before we tell the customer it failed.`,
      );
    }
    // Normal failure path. Default an unspecified reason to "ambiguous".
    return fail(failureCode ?? "ambiguous");
  }

  // --- raw.status === "confirmed" from here. Apply the evidence gate.
  if (failureCode) {
    return review(
      `Agent said confirmed but also set failureReason=${failureCode} — contradictory.`,
    );
  }
  if (materiallyOver) {
    return review(
      `Charged ${amount} cents which is materially over the ${budget}-cent budget.`,
    );
  }
  if (!hasValidCode && !hasConcreteEvidence) {
    return review(
      "Agent claimed success but produced no confirmation code or concrete evidence.",
    );
  }

  // Confirmed, evidence-backed.
  const confLabel = code
    ? `confirmation ${code}`
    : "your reservation is confirmed";
  return {
    ...base,
    status: "CONFIRMED",
    reviewReason: null,
    customerMessage: `Booked ✓ — ${confLabel}.`,
    showFallback: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Customer-facing failure copy                                                */
/* -------------------------------------------------------------------------- */

/**
 * Map a failure code to honest customer copy + whether to show the
 * website/phone manual fallback (the existing "Visit website" / "Call"
 * buttons in the itinerary dialog). We always offer a real next step — never
 * a dead end.
 */
export function failureCopy(
  code: FailureCode,
  venueName: string | null,
): { message: string; showFallback: boolean } {
  const at = venueName ? ` at ${venueName}` : "";
  switch (code) {
    case "declined_card":
      return {
        message: `The checkout${at} wouldn't accept our payment card. You can book it directly below.`,
        showFallback: true,
      };
    case "no_availability":
      return {
        message: `No availability${at} for your requested time. Try another slot directly with the venue.`,
        showFallback: true,
      };
    case "captcha_blocked":
      return {
        message: `This site has a security check we can't clear automatically. Please book directly below.`,
        showFallback: true,
      };
    case "login_required":
      return {
        message: `${venueName ?? "This venue"} requires an account login to book. Please book directly below.`,
        showFallback: true,
      };
    case "form_not_found":
      return {
        message: `We couldn't find an online booking form${at} — they likely take reservations by phone.`,
        showFallback: true,
      };
    case "budget_exceeded":
      return {
        message: `The real price${at} came in over budget, so we didn't book it. Review and book directly if you'd like.`,
        showFallback: true,
      };
    case "timeout":
      return {
        message: `This booking took too long and we stopped to be safe. You can finish it directly below.`,
        showFallback: true,
      };
    case "ambiguous":
    default:
      return {
        message: `We couldn't safely complete this booking automatically. Please finish it directly below.`,
        showFallback: true,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Map a verified outcome to the DB enums the executor persists.               */
/* Typed with local string-literal unions (NOT the Prisma enums) so the brain  */
/* stays decoupled from the schema migration that adds BookingStatus.          */
/* NEEDS_REVIEW. The executor assigns these straight to the Prisma enums once  */
/* the migration lands — the string values match by design.                    */
/* -------------------------------------------------------------------------- */

export type BookingStatusValue = "CONFIRMED" | "FAILED" | "NEEDS_REVIEW";
export type ConfirmationStateValue =
  | "CONFIRMED"
  | "FAILED"
  | "UNAVAILABLE"
  | "HOLDING";

export function toBookingStatus(v: VerifiedOutcome): BookingStatusValue {
  switch (v.status) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "FAILED":
      return "FAILED";
    case "NEEDS_REVIEW":
      return "NEEDS_REVIEW";
  }
}

export function toConfirmationState(v: VerifiedOutcome): ConfirmationStateValue {
  switch (v.status) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "FAILED":
      // A pure availability miss reads better as UNAVAILABLE than FAILED.
      return v.failureCode === "no_availability" ? "UNAVAILABLE" : "FAILED";
    case "NEEDS_REVIEW":
      // No dedicated item state; HOLDING communicates "in progress, not done".
      return "HOLDING";
  }
}

/* -------------------------------------------------------------------------- */
/* Confirmation-code / evidence validators (the anti-hallucination core)       */
/* -------------------------------------------------------------------------- */

/** Strings that look like a confirmation but carry no real reference. */
const CODE_DENYLIST = new Set([
  "n/a",
  "na",
  "n\\a",
  "none",
  "no",
  "unknown",
  "pending",
  "tbd",
  "null",
  "undefined",
  "confirmed",
  "confirmation",
  "success",
  "successful",
  "booked",
  "reserved",
  "reservation",
  "complete",
  "completed",
  "done",
  "ok",
  "okay",
  "yes",
  "see email",
  "check email",
  "check your email",
  "your email",
  "email",
  "-",
  "--",
  "0",
  "00",
  "000",
  "n.a.",
]);

/**
 * A confirmation code is only trustworthy if it's a non-placeholder token
 * with at least one alphanumeric and meaningful length. This is the primary
 * guard against the agent hallucinating "Confirmed!" with nothing behind it.
 */
export function cleanConfirmationCode(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 3) return null;
  if (CODE_DENYLIST.has(trimmed.toLowerCase())) return null;
  // Must contain at least one alphanumeric char (reject pure punctuation).
  if (!/[a-z0-9]/i.test(trimmed)) return null;
  // A real reference number/code almost always contains a digit OR is an
  // alnum token >= 5 chars. Reject short all-letter words like "good".
  const hasDigit = /\d/.test(trimmed);
  const isLongAlnum = /^[a-z0-9][a-z0-9\-_/#. ]{4,}$/i.test(trimmed);
  if (!hasDigit && !isLongAlnum) return null;
  return trimmed.slice(0, 120);
}

/** Evidence is usable only if it's a real sentence (not empty / one word). */
export function cleanEvidence(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 12) return null;
  return trimmed.slice(0, 500);
}
