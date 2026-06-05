/**
 * Stagehand-based booking runner — the FAST, DOM-driven engine.
 *
 * Why this exists: independent 2026 benchmarks put DOM-driven browser
 * automation (Stagehand, Browserbase) at ~89-90% reliability vs ~78%
 * for vision-based Computer Use, AND ~44% faster (Stagehand v3). Our
 * original agent (`agent.ts`) used raw Claude Computer Use — every
 * action was a ~10s screenshot → vision → guess-coordinates round-trip.
 * Stagehand reads the actual DOM and acts directly: no screenshots, no
 * coordinate-guessing, far less token spend.
 *
 * This runner owns its own Browserbase session (Stagehand creates it
 * with our captcha-solving + proxy + stealth settings) and drives the
 * booking with Stagehand's DOM agent, then EXTRACTS a structured outcome
 * from the final page with a Zod schema. The result feeds the same
 * skeptical `verifyOutcome` brain we already use — so the reliability
 * gate is unchanged; only the engine underneath got faster.
 *
 * v1 scope: handles the no-upfront-payment majority (golf tee times,
 * restaurant reservations, spa — all pay_at_property). For venues that
 * demand a card AT checkout, the agent is told to STOP and report
 * needs_review (same as the MVP card path) — the just-in-time card seam
 * for those lands next.
 */

import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import { env, optionalEnv } from "@/lib/env";
import { AGENT_VIEWPORT } from "./runtime";
import type { RawBookingOutcome } from "./outcome";

/** Stagehand model id — DOM agent driven by Claude. */
const STAGEHAND_MODEL =
  optionalEnv("STAGEHAND_MODEL") ?? "anthropic/claude-sonnet-4-5-20250929";
const MAX_STEPS = Number(optionalEnv("STAGEHAND_MAX_STEPS")) || 40;

/** Schema the agent extracts from the final page — maps 1:1 to our
 *  RawBookingOutcome so verifyOutcome can gate it unchanged. */
const stagehandOutcomeSchema = z.object({
  status: z
    .enum(["confirmed", "failed", "needs_review"])
    .describe(
      "confirmed ONLY if the page shows a real confirmation/reservation number or an explicit 'your reservation is confirmed' message. Otherwise needs_review or failed.",
    ),
  confirmationCode: z
    .string()
    .nullable()
    .describe("The exact confirmation/reservation/order number shown on screen, verbatim. null if none visible."),
  confirmationEvidence: z
    .string()
    .nullable()
    .describe("A short verbatim quote of the on-screen confirmation text. null if none."),
  amountChargedCents: z
    .number()
    .nullable()
    .describe("Amount charged in cents if a payment was taken, else null (most reservations pay at the venue)."),
  failureReason: z
    .enum([
      "declined_card",
      "no_availability",
      "captcha_blocked",
      "login_required",
      "form_not_found",
      "budget_exceeded",
      "ambiguous",
      "timeout",
    ])
    .nullable()
    .describe("Set ONLY when status is failed. The specific reason. null otherwise."),
  message: z
    .string()
    .describe("One short sentence describing the outcome for the customer."),
});

export type RunStagehandOptions = {
  startUrl: string;
  /** System prompt (the booking rulebook) + the concrete task instruction. */
  system: string;
  task: string;
  /** Browserbase anti-bot toggles (same flags as the legacy runtime). */
  solveCaptchas: boolean;
  advancedStealth: boolean;
  /** Hard wall-clock budget for the whole booking. */
  timeoutMs: number;
  /** Live progress callback → wire to updateProgress for the UI. */
  onStep?: (label: string) => void | Promise<void>;
};

export type RunStagehandResult = {
  outcome: RawBookingOutcome;
  /** Browserbase session-replay URL for the proof/debug surface. */
  sessionUrl: string | null;
};

/**
 * Payment addendum for the DOM agent. v1 has no just-in-time card tool,
 * so the agent must NOT enter any card. The majority of agent bookings
 * (golf tee times, restaurant reservations, spa) are pay-at-property
 * and complete WITHOUT a card. For the minority that demand a card at
 * checkout, the agent stops and the booking surfaces as needs_review.
 */
const PAYMENT_ADDENDUM = `

## Payment — IMPORTANT for this booking
Do NOT enter any credit card, and do NOT make up a card number. Most reservations (tee times, restaurant tables, spa) confirm WITHOUT payment — you pay at the venue. Complete those normally.
If the venue REQUIRES a card / deposit to finish the reservation, STOP before the card form. Do not enter anything. End by stating clearly that the booking reached the payment step and needs review (a human will complete payment). Never fabricate payment details.`;

export async function runStagehandBooking(
  opts: RunStagehandOptions,
): Promise<RunStagehandResult> {
  const apiKey = env("BROWSERBASE_API_KEY");
  const projectId = env("BROWSERBASE_PROJECT_ID");
  const system = opts.system + PAYMENT_ADDENDUM;

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey,
    projectId,
    model: {
      modelName: STAGEHAND_MODEL as never,
      apiKey: env("ANTHROPIC_API_KEY"),
    },
    systemPrompt: system,
    // Self-healing: Stagehand re-resolves a selector if the page shifted,
    // instead of failing the action. Big reliability win on dynamic sites.
    selfHeal: true,
    // Block the agent's actions until Browserbase finishes solving any
    // captcha — so the agent doesn't try to click through a challenge.
    waitForCaptchaSolves: opts.solveCaptchas,
    verbose: 0,
    browserbaseSessionCreateParams: {
      projectId,
      browserSettings: {
        viewport: {
          width: AGENT_VIEWPORT.width,
          height: AGENT_VIEWPORT.height,
        },
        ...(opts.solveCaptchas ? { solveCaptchas: true } : {}),
        ...(opts.advancedStealth ? { advancedStealth: true } : {}),
      },
      ...(opts.solveCaptchas ? { proxies: true } : {}),
      timeout: Math.ceil(opts.timeoutMs / 1000) + 60,
    } as never,
  });

  // Hard wall-clock — abort the agent if it runs long.
  const controller = new AbortController();
  const wallClock = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    await stagehand.init();
    const sessionUrl = stagehand.browserbaseSessionURL ?? null;

    // Navigate to the venue first so the agent starts on the right page.
    const page = stagehand.context.pages()[0];
    await opts.onStep?.(`Opening ${shortHost(opts.startUrl)}…`);
    await page.goto(opts.startUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });

    // DOM-mode agent: act / fillForm / extract / goto via the page's
    // accessibility tree — no screenshots, no coordinate guessing.
    const agent = stagehand.agent({
      mode: "dom",
      model: STAGEHAND_MODEL,
      systemPrompt: system,
    });

    let stepCount = 0;
    await agent.execute({
      instruction: opts.task,
      maxSteps: MAX_STEPS,
      signal: controller.signal,
      callbacks: {
        onStepFinish: async () => {
          stepCount += 1;
          await opts.onStep?.(progressLabel(stepCount));
        },
      },
    });

    // Pull the structured outcome from the FINAL page. This is the proof
    // gate — the agent's own claim of success is not trusted; we read the
    // confirmation off the page ourselves.
    await opts.onStep?.("Verifying the confirmation…");
    let extracted: z.infer<typeof stagehandOutcomeSchema>;
    try {
      extracted = await stagehand.extract(
        "Extract the booking outcome from the current page. Look for a confirmation/reservation number, an explicit confirmation message, and any amount charged. If the page is not a confirmation page, status is needs_review.",
        stagehandOutcomeSchema,
      );
    } catch {
      extracted = {
        status: "needs_review",
        confirmationCode: null,
        confirmationEvidence: null,
        amountChargedCents: null,
        failureReason: null,
        message: "Couldn't read a confirmation from the final page.",
      };
    }

    return {
      outcome: {
        status: extracted.status,
        confirmationCode: extracted.confirmationCode,
        confirmationEvidence: extracted.confirmationEvidence,
        amountChargedCents: extracted.amountChargedCents,
        failureReason: extracted.failureReason ?? undefined,
        message: extracted.message,
      },
      sessionUrl,
    };
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(err.message));
    return {
      outcome: {
        status: "failed",
        failureReason: aborted ? "timeout" : "ambiguous",
        message: err instanceof Error ? err.message : String(err),
      },
      sessionUrl: null,
    };
  } finally {
    clearTimeout(wallClock);
    await stagehand.close().catch(() => {});
  }
}

function progressLabel(step: number): string {
  if (step <= 1) return "Finding the booking form…";
  if (step <= 3) return "Filling your reservation details…";
  if (step <= 6) return "Working through the booking…";
  return "Finishing up…";
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
