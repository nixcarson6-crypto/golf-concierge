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
 *  SONNET. Haiku couldn't hold the multi-step plan on real reservation
 *  forms (it did the clicks but lost the thread — set the date then
 *  stalled instead of going date→party→time→submit). Booking a form is
 *  genuine multi-step reasoning, so it needs Sonnet. We make it FAST via
 *  mechanics (lean prompt, tight DOM-settle, skip redundant calls,
 *  enough steps to finish) — NOT by downgrading the model. Override with
 *  STAGEHAND_MODEL per-deploy. */
const STAGEHAND_MODEL =
  optionalEnv("STAGEHAND_MODEL") ?? "anthropic/claude-sonnet-4-6";
// Default step cap. A restaurant/tee-time/spa reservation (navigate →
// reservations → date → party → time slot → name/email/phone → submit →
// confirmation) legitimately takes ~15-25 steps, so 35 is plenty AND
// keeps those FAST. Hotels are a different beast — date picker → search →
// room list → rate → guest details → checkout is a long flow that blew
// past 35 (Belmond hit the cap mid-flow). The caller passes a per-type
// budget via opts.maxSteps; this is the fallback. The wall-clock timeout
// is the real backstop either way.
const MAX_STEPS = Number(optionalEnv("STAGEHAND_MAX_STEPS")) || 35;

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
  /** Per-booking step budget. Restaurants/tee-times are quick (~35);
   *  hotels need more (~55) for the longer date→room→rate→guest flow.
   *  Falls back to MAX_STEPS / the STAGEHAND_MAX_STEPS env when unset. */
  maxSteps?: number;
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
const STAGEHAND_SYSTEM = `You are Pyltrix's booking agent. You book HOTELS and GOLF TEE TIMES — nothing else. You have FULL AUTHORITY to complete the reservation on the customer's behalf: clicking buttons, picking rooms/time slots, typing details, and submitting the form ARE your job. The customer already authorized this. Don't stop "to let the customer review" — there is no review step. Either finish the booking or report exactly why you can't.

Make ONE real reservation at the venue in the task — for the EXACT date(s)/party given — then stop. Be FAST and decisive: ~8-15 steps. Never re-read a page you've already seen, and never scroll just to explore — decide and act.

STEP 0 — CLEAR THE PAGE FIRST (before anything else, on EVERY new page): if a cookie / consent / privacy / GDPR banner or modal shows, DISMISS IT by clicking the most permissive accept button — "Accept", "Accept all", "I agree", "OK", "Got it", "Allow all", or in another language "Aceptar"/"Accetta tutti"/"Zustimmen"/"Tout accepter". These overlays sit ON TOP of the page and intercept every click — if you don't clear it, nothing works and you stall. Clicking accept is always safe. Close newsletter/popup overlays the same way (X / Close / No thanks). Only then start booking.

CORE RULES
1. FINISH THE BOOKING. Reaching a room list / time-slot picker / checkout button is HALFWAY done, not done. Select the room/slot, fill the form, click the final submit. The only valid stops are: a real confirmation page, the payment/deposit step (see rule 6), or a listed failure.
2. ONE submission only. Never submit twice. If you submit and can't see clear confirmation, report needs_review — never resubmit (a double-booking is worse than a missed one).
3. CONFIRMED requires PROOF: a real confirmation/reservation/order number or an explicit "your reservation is confirmed" message — quote it. Submitted but no confirmation visible → needs_review.
4. NEVER invent data. Use only the traveler details in the task. If a REQUIRED field needs something you weren't given, report needs_review.
5. NEVER exceed the budget ceiling (including taxes/fees/deposit). Over budget → failed / budget_exceeded.
6. PAYMENT: do NOT enter a card. When you reach a card/deposit step, STOP and report needs_review, quoting the exact room/tee time + total price you reached (e.g. "Standard King — $1,325 for 5 nights, stopped at the deposit step") so the customer can finish payment. Reaching the payment step with everything filled is a GOOD outcome, not a failure.

DATES (get these right — most failures start here)
- Use the EXACT dates from the task. If the date field is a text box, type the date in the format it shows (try MM/DD/YYYY). If it's a calendar widget, use the month arrows to reach the right month, then click the day.
- HOTEL: set BOTH check-in AND check-out so the night count matches — never leave it at one night or "today".
- Many sites default to today's date and show "no availability" — always set the requested date FIRST, then read availability.

HOTEL PLAYBOOK
1. Click Book / Reserve / Book Now / Check Availability.
2. Set check-in, check-out, and guest count. Search.
3. Pick a room. **The room/suite name in the task is a PREFERENCE, not a requirement.** If the exact named room (e.g. "Junior Suite") isn't listed, pick the FIRST available room that sleeps the party and fits budget. The search returning rooms — even differently-named ones — means the hotel IS available: select one and CONTINUE. Quitting because the named room isn't listed is a failure you must never make. Don't compare every room or re-read the page — choose one and move on.
4. Continue to guest details, fill name/email/phone, proceed toward booking, and STOP at the payment/deposit step per rule 6.

GOLF / TEE-TIME PLAYBOOK
- The booking lives under "Tee Times", "Book a Tee Time", "Golf", "Reserve", or a resort's "Experiences" / "Recreation" section — open it.
- Many courses embed a booking widget (GolfNow, Lightspeed/Chronogolf, ForeUp, TeeQuest). That widget IS the real booking system — use it, even if the URL host changes.
- Set the DATE and number of PLAYERS, then pick the tee time at or closest to the requested time. Click the slot (don't stop on the picker — clicking it opens the form), fill the player/contact details, and book. If a card/deposit is required, STOP per rule 6.

WHEN TO STOP (report honestly)
- Real confirmation visible → confirmed, number quoted.
- No availability for the requested date (after confirming the date is set correctly) → failed / no_availability.
- A captcha you can't pass → failed / captcha_blocked. Mandatory account login you don't have → failed / login_required.
- Genuinely no online booking path at all (phone/email only) → failed / form_not_found — and quote the phone/email you saw.
- Card/deposit step reached → needs_review with the room/tee time + price (rule 6).
- Going in circles with no progress → needs_review describing exactly where you're stuck.`;

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
    // Shorter DOM-settle (default ~3s) shaves time off every step where
    // the page is already stable. 1000ms is enough for most booking
    // widgets to paint; the self-heal + per-action waits cover the rest.
    domSettleTimeout: 1000,
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

    // Pre-clear cookie / consent overlays BEFORE handing off to the agent.
    // These banners sit on top of the page and intercept every click — the
    // #1 cause of a run stalling (Carson watched the agent sit on Finca
    // Cortesin's "This website uses cookies" modal the whole run). One
    // cheap up-front act() dismisses it deterministically so the agent
    // starts on a clear page. Best-effort: no banner ⇒ fast no-op; any
    // error is swallowed (STEP 0 in the system prompt is the backstop).
    try {
      await opts.onStep?.("Clearing cookie banner…");
      await stagehand.act(
        "If a cookie consent, privacy, or GDPR banner/modal is visible, click the button that accepts all cookies (labelled Accept, Accept all, I agree, OK, Allow all, or the equivalent in another language like Accetta tutti / Aceptar / Tout accepter / Zustimmen) to dismiss it. Also close any newsletter or promo popup. If nothing like that is visible, do nothing.",
      );
      console.log(`[stagehand] ✓ consent pre-clear done (${elapsed()})`);
    } catch (e) {
      console.warn(
        `[stagehand] consent pre-clear skipped: ${e instanceof Error ? e.message : e}`,
      );
    }

    // DOM-mode agent: act / fillForm / extract / goto via the page's
    // accessibility tree — no screenshots, no coordinate guessing.
    //
    // SPEED via split models (NOT downgrading the brain):
    //   model          = Sonnet — high-level planning ("now set the
    //                    party size, then the time, then submit"). This
    //                    is the part Haiku couldn't do.
    //   executionModel = Haiku — the per-action observe/act tool calls
    //                    ("find the date field", "click 7:30 PM"). These
    //                    are the BULK of the calls and don't need
    //                    reasoning, so Haiku runs them ~3x faster/cheaper
    //                    while Sonnet stays in charge of the plan.
    const agent = stagehand.agent({
      mode: "dom",
      model: STAGEHAND_MODEL,
      executionModel:
        optionalEnv("STAGEHAND_EXECUTION_MODEL") ?? "anthropic/claude-haiku-4-5",
      systemPrompt: system,
    });

    const maxSteps = opts.maxSteps ?? MAX_STEPS;
    console.log(`[stagehand] agent.execute starting (maxSteps=${maxSteps})…`);
    let stepCount = 0;
    const result = await agent.execute({
      instruction: opts.task,
      maxSteps,
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
    //
    // FAST PATH: when the agent has already CLAIMED a failure or NEEDS_REVIEW
    // in its own message, skip the extract() — saves ~10s + a Haiku call.
    // The agent's natural-language message is honest about its own state; we
    // only need to RE-VERIFY when it claims success (the skeptical gate).
    const agentClaimsConfirmed = /confirm(ed|ation)|reservation (#|number|id)/i.test(
      agentMsg,
    );
    let extracted: z.infer<typeof stagehandOutcomeSchema>;
    if (result.success === false && !agentClaimsConfirmed) {
      console.log(
        "[stagehand] skipping extract() — agent already reported non-success, trusting its message.",
      );
      extracted = {
        status: classifyFromAgentMessage(agentMsg),
        confirmationCode: null,
        confirmationEvidence: null,
        amountChargedCents: null,
        failureReason: reasonFromAgentMessage(agentMsg) ?? null,
        message: agentMsg.slice(0, 240) || "Booking did not complete.",
      };
    } else {
      await opts.onStep?.("Verifying the confirmation…");
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

/** Map the agent's free-text "what happened" message to our schema's
 *  status enum. Used on the fast path when we skip the extract() call. */
function classifyFromAgentMessage(
  msg: string,
): "confirmed" | "failed" | "needs_review" {
  const m = (msg ?? "").toLowerCase();
  if (/no (rooms?|availability|times?|slots?)|sold out|fully booked|unavailable/i.test(m))
    return "failed";
  if (/captcha|are you (a )?human|bot detection|cloudflare/i.test(m))
    return "failed";
  if (/must (sign in|log in)|account required|login required/i.test(m))
    return "failed";
  if (/card (required|needed)|deposit|prepay|payment required/i.test(m))
    return "needs_review";
  if (/no (online booking|reservation system|booking form)|phone[- ]?only/i.test(m))
    return "failed";
  return "needs_review";
}

function reasonFromAgentMessage(
  msg: string,
):
  | "no_availability"
  | "captcha_blocked"
  | "login_required"
  | "form_not_found"
  | "ambiguous"
  | undefined {
  const m = (msg ?? "").toLowerCase();
  if (/no (rooms?|availability|times?|slots?)|sold out|fully booked|unavailable/i.test(m))
    return "no_availability";
  if (/captcha|are you (a )?human|bot detection|cloudflare/i.test(m))
    return "captcha_blocked";
  if (/must (sign in|log in)|account required|login required/i.test(m))
    return "login_required";
  if (/no (online booking|reservation system|booking form)|phone[- ]?only/i.test(m))
    return "form_not_found";
  return "ambiguous";
}
