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

/** Stagehand model id — DOM agent driven by Claude.
 *  MUST be a CURRENTLY-AVAILABLE model. claude-sonnet-4-5-20250929 was
 *  retired and calling it made the agent throw instantly (the 27s
 *  black-screen "Completed" Carson saw). claude-sonnet-4-6 is current,
 *  fast, and the right tier for form-filling. Override per-deploy with
 *  STAGEHAND_MODEL if Anthropic ships a newer one. */
const STAGEHAND_MODEL =
  optionalEnv("STAGEHAND_MODEL") ?? "anthropic/claude-sonnet-4-6";
// 25-step cap (was 40). The lean prompt targets 8-15 steps for a normal
// booking; 25 leaves headroom for a complex multi-page flow without
// letting a confused agent burn 40 LLM calls (and Carson's credits).
const MAX_STEPS = Number(optionalEnv("STAGEHAND_MAX_STEPS")) || 25;

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
/**
 * LEAN system prompt, purpose-built for the Stagehand DOM agent.
 *
 * The original goal.ts system prompt is ~3,000 words written for the
 * vision/computer-use agent — full of "take a screenshot", "alt+F2",
 * coordinate instructions, batch-actions-per-turn, etc. that the DOM
 * agent doesn't use. Re-sending that wall of text on EVERY step was the
 * main reason each step took 5-30s and bookings burned huge token
 * counts (Carson's 28-step, 6-minute, credit-draining runs). This is
 * the same rules, tight — only what the DOM agent needs.
 */
const STAGEHAND_SYSTEM = `You are Pyltrix's booking agent. Make ONE real reservation at the venue described in the task — for the EXACT date(s)/time/party given — then stop. Work the page with clicks, typing, and form-filling. Be FAST and decisive: a normal booking is 8-15 steps. Don't re-read pages you've already seen.

RULES
1. ONE booking only. Never submit twice. If you submit and aren't certain it went through, report needs_review — never resubmit (a double-booking is worse than a missed one).
2. NEVER claim success without proof. "confirmed" requires a real confirmation/reservation/order number OR an explicit "your reservation is confirmed" message visible on the page — read it and quote it. If you don't see that, it's needs_review or failed, never confirmed.
3. NEVER invent data. Use only the traveler details in the task. If a REQUIRED field needs something you weren't given, report needs_review.
4. DATES: use the EXACT check-in/check-out (for hotels) or date/time (for everything else) from the task. For a hotel, set BOTH the arrival AND departure dates so the full night count matches — do not book a single night unless the task says one night.
5. BUDGET: if the total looks far above normal for this booking, or over a stated ceiling, stop and report failed / budget_exceeded.
6. PAYMENT: do NOT enter any card or make one up. Most reservations (tee times, tables, spa) confirm WITHOUT payment — finish those normally. If a card/deposit is required to complete, STOP at the card step and report needs_review.

FINDING THE BOOKING
- Look for: Book, Reserve, Reservations, Check Availability, Book a table, Book a tee time.
- Resort tee times / spa / activities usually live under "Experiences", "Activities", "Things to Do", "Recreation", or "Golf" — open the specific one, then use its Check Availability / Add to Cart flow.
- Multi-location chains show a city picker (e.g. "Aspen | Boulder"). Click the DESTINATION CITY named in the task.
- If the venue's own site has no form but mentions OpenTable / Resy / Tock, go to that platform (opentable.com / resy.com / exploretock.com), search the venue name + city, click the matching result (verify the address), and book there. The platform IS the venue's real reservation system — that's not the wrong venue.
- Dismiss cookie banners and popups. Use guest checkout. Decline add-ons, upgrades, marketing.

WHEN TO STOP (report the outcome honestly)
- Real confirmation visible → confirmed, with the number quoted.
- No availability for the requested dates → failed / no_availability. (First double-check you entered the dates correctly — a single-night search on a multi-night stay often shows "no rooms".)
- Genuinely no online booking AND no platform mentioned (phone/email only) → failed / form_not_found.
- A captcha you can't pass → failed / captcha_blocked. A mandatory account login you don't have → failed / login_required.
- A card is required to finish → needs_review.`;

export async function runStagehandBooking(
  opts: RunStagehandOptions,
): Promise<RunStagehandResult> {
  const apiKey = env("BROWSERBASE_API_KEY");
  const projectId = env("BROWSERBASE_PROJECT_ID");
  // Use the lean DOM-native prompt, NOT the heavy vision-era goal.system
  // that run-booking passes (kept on opts.system for the computer-use
  // fallback). This is the single biggest speed + cost win.
  const system = STAGEHAND_SYSTEM;

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
    // We pass agent callbacks (onStepFinish → live progress) and an abort
    // signal (our wall-clock timeout) to agent.execute(). Stagehand
    // requires experimental: true + disableAPI: true to use those — the
    // server-side Stagehand API path doesn't support them. disableAPI
    // just runs the LLM directly (no Stagehand-cloud caching), which is
    // exactly what we want: fresh session per booking, no shared cache.
    experimental: true,
    disableAPI: true,
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
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  try {
    console.log(
      `[stagehand] init… model=${STAGEHAND_MODEL} captcha=${opts.solveCaptchas} stealth=${opts.advancedStealth}`,
    );
    await stagehand.init();
    const sessionUrl = stagehand.browserbaseSessionURL ?? null;
    console.log(`[stagehand] ✓ session ready (${elapsed()}) ${sessionUrl ?? ""}`);

    // Navigate to the venue first so the agent starts on the right page.
    const page = stagehand.context.pages()[0];
    if (!page) {
      throw new Error(
        "Stagehand init returned no page — the Browserbase session never opened a tab.",
      );
    }
    await opts.onStep?.(`Opening ${shortHost(opts.startUrl)}…`);
    await page.goto(opts.startUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });
    console.log(`[stagehand] ✓ navigated to ${opts.startUrl} (${elapsed()})`);

    // DOM-mode agent: act / fillForm / extract / goto via the page's
    // accessibility tree — no screenshots, no coordinate guessing.
    const agent = stagehand.agent({
      mode: "dom",
      model: STAGEHAND_MODEL,
      systemPrompt: system,
    });

    console.log(`[stagehand] agent.execute starting (maxSteps=${MAX_STEPS})…`);
    let stepCount = 0;
    const result = await agent.execute({
      instruction: opts.task,
      maxSteps: MAX_STEPS,
      signal: controller.signal,
      callbacks: {
        onStepFinish: async () => {
          stepCount += 1;
          console.log(`[stagehand]   step ${stepCount} done (${elapsed()})`);
          await opts.onStep?.(progressLabel(stepCount));
        },
      },
    });
    console.log(
      `[stagehand] ✓ agent finished (${elapsed()}) success=${result.success} completed=${result.completed} steps=${result.actions?.length ?? stepCount}\n  agent message: ${result.message?.slice(0, 300)}`,
    );

    // If the agent crashed internally (Stagehand surfaces these as
    // success=false with the error in result.message rather than
    // throwing), DON'T waste an extract() call — the session is usually
    // dead. Classify and return immediately so the retry loop / UI gets
    // an honest reason instead of a misleading needs_review.
    const agentMsg = result.message ?? "";
    if (result.success === false) {
      if (/credit balance is too low|insufficient.*credit|quota/i.test(agentMsg)) {
        console.error("[stagehand] ✗ Anthropic credits exhausted mid-booking.");
        return {
          outcome: {
            status: "failed",
            failureReason: "ambiguous",
            message:
              "Booking stopped — the AI account ran out of credits. Top up Anthropic billing and try again.",
          },
          sessionUrl,
        };
      }
      if (
        /awaitActivePage|Cannot read properties of null|transport closed|socket-close|CDP/i.test(
          agentMsg,
        )
      ) {
        console.error(`[stagehand] ✗ session crashed mid-run: ${agentMsg.slice(0, 160)}`);
        return {
          outcome: {
            status: "failed",
            // ambiguous IS retryable — a fresh session usually recovers
            // from a CDP/transport drop.
            failureReason: "ambiguous",
            message:
              "The booking session dropped before finishing — retrying on a fresh session.",
          },
          sessionUrl,
        };
      }
    }

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
    } catch (exErr) {
      console.warn(
        `[stagehand] extract() failed (${elapsed()}): ${exErr instanceof Error ? exErr.message : exErr}`,
      );
      extracted = {
        status: "needs_review",
        confirmationCode: null,
        confirmationEvidence: null,
        amountChargedCents: null,
        failureReason: null,
        message: "Couldn't read a confirmation from the final page.",
      };
    }
    console.log(
      `[stagehand] outcome: status=${extracted.status} code=${extracted.confirmationCode ?? "—"} reason=${extracted.failureReason ?? "—"} :: ${extracted.message}`,
    );

    // If the agent itself said it did NOT complete and the page shows no
    // confirmation, prefer the agent's own explanation in the message —
    // it usually says exactly what blocked it.
    const message =
      extracted.status !== "confirmed" &&
      result.completed === false &&
      result.message
        ? result.message.slice(0, 240)
        : extracted.message;

    return {
      outcome: {
        status: extracted.status,
        confirmationCode: extracted.confirmationCode,
        confirmationEvidence: extracted.confirmationEvidence,
        amountChargedCents: extracted.amountChargedCents,
        failureReason: extracted.failureReason ?? undefined,
        message,
      },
      sessionUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(msg));
    // Loud, tagged, one-line root cause — so the dev terminal shows
    // exactly why the agent stopped instead of a silent black screen.
    console.error(`[stagehand] ✗ FAILED (${elapsed()}) — ${msg}`);
    return {
      outcome: {
        status: "failed",
        failureReason: aborted ? "timeout" : "ambiguous",
        message: msg,
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
