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
import type { CardProvider } from "./agent";

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

// Per-ACTION timeout (one act()/click()/extract() call inside a step).
// Stagehand's default is 45s — far too generous for our ~10-min wall clock:
// a single hung selector on a heavy site (Rocco Forte/Verdura's homepage was
// the case that exposed this) silently burns 45s doing nothing, and 2-3 of
// those exhaust the budget before the agent ever reaches room selection. We
// cap it at 25s: long enough for a legit slow action / aria-tree build on a
// big page, short enough that a genuine hang fails fast, hands the agent the
// "try a different description" hint, and lets it recover + keep making
// progress. Tunable per-deploy via STAGEHAND_TOOL_TIMEOUT_MS.
const TOOL_TIMEOUT_MS = Number(optionalEnv("STAGEHAND_TOOL_TIMEOUT_MS")) || 25_000;

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
  /**
   * Just-in-time payment. When set, the runner drives the booking up to
   * the card-entry step, then calls this to charge the customer + mint a
   * single-use virtual card, and types that card in to complete payment.
   * When unset (or it returns `unavailable`), the runner stops at the
   * payment step and reports needs_review — no card is ever entered.
   */
  cardProvider?: CardProvider;
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
const STAGEHAND_SYSTEM = `You are Pyltrix's booking agent. You book HOTELS, GOLF TEE TIMES, and CAR RENTALS — nothing else. You have FULL AUTHORITY to complete the reservation on the customer's behalf: clicking buttons, picking rooms/time slots/cars, typing details, and submitting the form ARE your job. The customer already authorized this. Don't stop "to let the customer review" — there is no review step. Either finish the booking or report exactly why you can't.

Make ONE real reservation at the venue in the task — for the EXACT date(s)/party given — then stop. Be FAST and decisive: ~8-15 steps. Never re-read a page you've already seen, and never scroll just to explore — decide and act.

STEP 0 — CLEAR THE PAGE FIRST (before anything else, on EVERY new page): if a cookie / consent / privacy / GDPR banner or modal shows, DISMISS IT by clicking the most permissive accept button — "Accept", "Accept all", "I agree", "OK", "Got it", "Allow all", or in another language "Aceptar"/"Accetta tutti"/"Zustimmen"/"Tout accepter". These overlays sit ON TOP of the page and intercept every click — if you don't clear it, nothing works and you stall. Clicking accept is always safe. Close newsletter/popup overlays the same way (X / Close / No thanks). Only then start booking.

CORE RULES
1. FINISH THE BOOKING. Reaching a room list / time-slot picker / checkout button is HALFWAY done, not done. Select the room/slot, fill the form, click the final submit. The only valid stops are: a real confirmation page, the payment/deposit step (see rule 6), or a listed failure.
2. ONE submission only. Never submit twice. If you submit and can't see clear confirmation, report needs_review — never resubmit (a double-booking is worse than a missed one).
3. CONFIRMED requires PROOF: a real confirmation/reservation/order number or an explicit "your reservation is confirmed" message — quote it. Submitted but no confirmation visible → needs_review.
4. NEVER invent data. Use only the traveler details in the task. If a REQUIRED field needs something you weren't given, report needs_review.
5. NEVER exceed the budget ceiling (including taxes/fees/deposit). Over budget → failed / budget_exceeded.
6. PAYMENT: do NOT type any card number yourself, and never make one up. Drive the booking all the way TO the card-entry step — pick the room/tee time, fill all guest/driver details, accept mandatory terms — and STOP the moment a credit-card NUMBER is required, leaving the card fields blank. Reaching that filled-in payment step is a GOOD outcome: the system takes over from there to enter payment securely. In your message, quote the exact room/tee time + total price you reached (e.g. "Standard King — $1,325 for 5 nights, at the card step").

DATES (get these right — most failures start here)
- Use the EXACT dates from the task. If the date field is a text box, type the date in the format it shows (try MM/DD/YYYY). If it's a calendar widget, use the month arrows to reach the right month, then click the day.
- HOTEL: set BOTH check-in AND check-out so the night count matches — never leave it at one night or "today".
- Many sites default to today's date and show "no availability" — always set the requested date FIRST, then read availability.

HOTEL PLAYBOOK
1. Click Book / Reserve / Book Now / Check Availability.
2. Set check-in, check-out, and guest count. Search.
3. Pick a room. **The room/suite name in the task is a PREFERENCE, not a requirement.** If the exact named room (e.g. "Junior Suite") isn't listed, pick the FIRST available room that sleeps the party and fits the budget. The search returning rooms — even differently-named ones — means the hotel IS available: select one and CONTINUE. Quitting because the named room isn't listed is a failure you must never make. Don't compare every room or re-read the page — choose one and move on.
4. WHEN THE PAGE SHOWS RATES WITH "RESERVE" / "BOOK" BUTTONS, YOUR ACTION IS TO CLICK ONE. Do not keep reading. Do not "pause to think". Click. If multiple rate options for the same room are shown (e.g. "Best Flexible Rate" vs "Best Flexible With Breakfast"), pick the CHEAPEST that fits the budget and click ITS Reserve/Book button. Sitting on a rate list without clicking is the same failure as quitting.
5. BUDGET — if the CHEAPEST available rate for any suitable room exceeds the budget ceiling, do NOT just stop. Report failed / budget_exceeded in your message and QUOTE THE EXACT PRICE you saw (e.g. "Cheapest available rate is Quinta Courtyard Suite at $24,368 for 7 nights — over the $X budget"). Never stop silently when the only issue is price.
6. Continue to guest details, fill name/email/phone, proceed toward booking, and STOP at the payment/card step per rule 6 above (the system pays).

GOLF / TEE-TIME PLAYBOOK
- The booking lives under "Tee Times", "Book a Tee Time", "Golf", "Reserve", or a resort's "Experiences" / "Recreation" section — open it.
- Many courses embed a booking widget (GolfNow, Lightspeed/Chronogolf, ForeUp, TeeQuest). That widget IS the real booking system — use it, even if the URL host changes.
- Set the DATE and number of PLAYERS, then pick the tee time at or closest to the requested time. Click the slot (don't stop on the picker — clicking it opens the form), fill the player/contact details, and book. If a card/deposit is required, STOP per rule 6.

CAR-RENTAL PLAYBOOK
1. Find the rental search — pick-up location, pick-up date/time, and drop-off date/time. Set them from the task (use the city/airport in the task as the pick-up location).
2. Search, then pick a vehicle. **The car class in the task (e.g. "Luxury SUV", "Standard") is a PREFERENCE.** If that exact class isn't offered, pick the closest available vehicle that fits the party and budget — never quit because the named class isn't listed.
3. Choose "pay at counter" / "pay later" over prepaid when both exist (avoids the card step). Decline insurance, extras, and upsells unless mandatory.
4. Continue to the driver-details form, fill name/email/phone, and proceed. If a card/prepayment is required to confirm, STOP per rule 6 and quote the car + total price.

WHEN TO STOP (report honestly)
- Real confirmation visible → confirmed, number quoted.
- No availability for the requested date (after confirming the date is set correctly) → failed / no_availability.
- A captcha you can't pass → failed / captcha_blocked. Mandatory account login you don't have → failed / login_required.
- Genuinely no online booking path at all (phone/email only) → failed / form_not_found — and quote the phone/email you saw.
- Card/deposit step reached → STOP with everything filled and the card fields BLANK (rule 6 — the system enters payment); note the room/tee time + total.
- Going in circles with no progress → needs_review describing exactly where you're stuck.

NEVER STOP SILENTLY. If you can see a Reserve/Book/Submit button that fits the task, click it. If you can't proceed for any reason — budget, missing field, broken flow, unclear UI — say WHY in your message, with the exact prices/labels you saw. "Just stopping" with no actionable message is the worst failure mode.`;

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
    // SPEED: drop heavy third-party junk (analytics, ad/marketing tags,
    // session-replay, autoplay video) at the network layer BEFORE the first
    // navigation. The DOM agent reads the accessibility tree, not pixels, so
    // none of this is needed — but on luxury-hotel sites it's often the bulk
    // of what a page waits on, so blocking it shaves seconds off every page
    // load AND every domSettle. Deliberately tracker/media-only: CSS, images,
    // fonts, and captcha/recaptcha/turnstile are left untouched so layout,
    // confirmation reads, and the captcha-solver all keep working.
    await blockHeavyResources(page);

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
      // FAST PATH: a deterministic in-page DOM pass clicks the accept button
      // of the common consent managers (OneTrust, Cookiebot, Didomi,
      // Usercentrics…) and any button whose visible label reads
      // Accept/Agree/OK in 7 languages. One CDP round-trip, no LLM call —
      // this is the case that used to cost a full ~5-10s act() on EVERY run.
      const cleared = await dismissConsentDeterministically(page);
      if (cleared) {
        console.log(
          `[stagehand] ✓ consent dismissed deterministically ("${cleared}") (${elapsed()})`,
        );
      } else {
        // BACKSTOP: only when the fast pass found nothing do we spend an
        // LLM act() — catches the non-standard banners the DOM scan misses.
        await stagehand.act(
          "If a cookie consent, privacy, or GDPR banner/modal is visible, click the button that accepts all cookies (labelled Accept, Accept all, I agree, OK, Allow all, or the equivalent in another language like Accetta tutti / Aceptar / Tout accepter / Zustimmen) to dismiss it. Also close any newsletter or promo popup. If nothing like that is visible, do nothing.",
        );
        console.log(`[stagehand] ✓ consent pre-clear via act() (${elapsed()})`);
      }
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
    console.log(
      `[stagehand] agent.execute starting (maxSteps=${maxSteps}, toolTimeout=${TOOL_TIMEOUT_MS}ms)…`,
    );
    let stepCount = 0;
    const result = await agent.execute({
      instruction: opts.task,
      maxSteps,
      // Cap each individual tool call so a hung action recovers fast instead
      // of eating 45s of the wall-clock budget (see TOOL_TIMEOUT_MS above).
      toolTimeout: TOOL_TIMEOUT_MS,
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
      `[stagehand] ✓ agent finished (${elapsed()}) success=${result.success} completed=${result.completed} steps=${result.actions?.length ?? stepCount}\n  agent message: ${result.message?.slice(0, 600) || "(no message)"}`,
    );
    // Loud flag when the agent stops without saying anything useful — that's
    // the "just stopped" case and we want it screaming in the terminal so we
    // can see it instead of a quiet needs_review later.
    if ((result.message ?? "").trim().length < 40) {
      console.warn(
        `[stagehand] ⚠ thin/empty agent message — likely a silent stop. steps=${stepCount}, last progress label may indicate where.`,
      );
    }

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

    // ── PAYMENT PHASE ────────────────────────────────────────────────────
    // If a card provider is wired AND the agent didn't already crash or
    // confirm, check whether it stopped at a card-entry step. If so, charge
    // the customer + mint a single-use virtual card (cardProvider) and type
    // it in to finish. The PAN is fetched here, used once, and never logged
    // or persisted; the single-use card + the <2s auth webhook bound the
    // blast radius to exactly this one charge.
    const agentAlreadyConfirmed = /confirm(ed|ation)|reservation (#|number|id)/i.test(
      agentMsg,
    );
    if (
      opts.cardProvider &&
      result.success !== false &&
      !agentAlreadyConfirmed
    ) {
      const pay = await detectPaymentStep(stagehand).catch(() => ({
        atPayment: false,
        amountCents: null,
        currency: null,
      }));
      if (pay.atPayment) {
        console.log(
          `[stagehand] payment step detected (${elapsed()}) — total=${pay.amountCents != null ? `${pay.amountCents}c ${pay.currency ?? ""}` : "unknown"} — charging + paying`,
        );
        await opts.onStep?.("Securing payment…");
        const card = await opts.cardProvider(pay.amountCents);
        if (card.status !== "ok") {
          // Couldn't charge / no saved card / Stripe off → stop cleanly at
          // payment. NEVER enter a card we don't have. Customer not charged.
          console.warn(`[stagehand] card provider unavailable: ${card.reason}`);
          return {
            outcome: {
              status: "needs_review",
              message:
                "Everything's filled in and ready to pay — we paused at the payment step. " +
                card.reason.replace(/\s*(Stop entering payment and )?call report_outcome[^.]*\.?/gi, "").trim(),
            },
            sessionUrl,
          };
        }
        // Card in hand. Type it and submit. Scoped instruction — the PAN
        // appears only in THIS execute call, not the booking-navigation
        // context, and we deliberately do NOT log the result message.
        await opts.onStep?.("Completing payment…");
        try {
          await agent.execute({
            instruction: cardEntryInstruction(card),
            maxSteps: 14,
            signal: controller.signal,
            callbacks: {
              onStepFinish: async () => {
                await opts.onStep?.("Completing payment…");
              },
            },
          });
          console.log(`[stagehand] ✓ payment submitted (${elapsed()})`);
        } catch (payErr) {
          // Customer is already charged (cardProvider charged before we
          // typed). The funded single-use card lets a human finish, so
          // surface needs_review, NOT a failure — never imply we lost money.
          console.error(
            `[stagehand] payment-entry error (${elapsed()}): ${payErr instanceof Error ? payErr.message : payErr}`,
          );
          return {
            outcome: {
              status: "needs_review",
              message:
                "We secured your payment but hit a snag entering it on the venue's checkout — Pyltrix is finishing this booking manually and will confirm shortly.",
            },
            sessionUrl,
          };
        }
        // Fall through to the proof extract below — it reads the
        // confirmation off the post-payment page.
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

/**
 * Is the browser sitting at a card-entry / payment step, and if so what's
 * the total being charged? One cheap extract read of the current page. The
 * total is the source of truth for what we charge (most items carry no
 * upfront price). Fails closed (atPayment=false) — we only ever ENTER a
 * card when we're confident it's the real checkout, never speculatively.
 */
async function detectPaymentStep(
  stagehand: Stagehand,
): Promise<{ atPayment: boolean; amountCents: number | null; currency: string | null }> {
  const schema = z.object({
    atPaymentStep: z
      .boolean()
      .describe(
        "true ONLY if the current page is asking for a credit/debit CARD NUMBER to complete this booking (a card-number field, or a 'Payment'/'Pay'/'Checkout' step with card inputs). false for room lists, guest-detail forms, confirmation pages, or anything without a card field.",
      ),
    totalAmount: z
      .number()
      .nullable()
      .describe(
        "The TOTAL amount that will be charged, in major currency units (e.g. 1325.00 for $1,325). The grand total / amount due, not a per-night rate. null if not clearly shown.",
      ),
    currency: z
      .string()
      .nullable()
      .describe("3-letter currency code of the total (USD, EUR, GBP, …) if shown, else null."),
  });
  const res = await stagehand.extract(
    "Determine whether the current page is the payment / card-entry step that needs a credit card number to finish the booking, and read the grand total to be charged.",
    schema,
  );
  const amountCents =
    res?.totalAmount != null && Number.isFinite(res.totalAmount) && res.totalAmount > 0
      ? Math.round(res.totalAmount * 100)
      : null;
  return {
    atPayment: Boolean(res?.atPaymentStep),
    amountCents,
    currency: res?.currency ?? null,
  };
}

/**
 * Scoped instruction that hands the agent the single-use virtual card to
 * type. Kept terse and used in exactly one execute() call so the PAN never
 * enters the long booking-navigation context. The billing ZIP matches the
 * Issuing cardholder's billing address (94105) so AVS checks pass.
 */
function cardEntryInstruction(card: {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  cardholderName?: string;
}): string {
  const mm = String(card.expMonth).padStart(2, "0");
  const yy2 = String(card.expYear).slice(-2);
  const name = card.cardholderName ?? "Pyltrix Traveler";
  return [
    "You are on the payment step. Enter this card to complete the booking, then submit ONCE.",
    `- Card number: ${card.number}`,
    `- Expiry: ${mm}/${yy2} (or ${mm}/${card.expYear} if a 4-digit year is required)`,
    `- CVC / security code: ${card.cvc}`,
    `- Name on card: ${name}`,
    "- If a billing ZIP/postal code is required, use 94105. If billing address is required, use 1 Market St, San Francisco, CA 94105, US.",
    "Fill the card fields with EXACTLY these values (card-number fields are often inside a small frame — click into the field first, then type). Tick any mandatory terms checkbox. Then click the final Pay / Confirm / Complete Booking button exactly ONCE and wait for the page to change. Do NOT click pay twice.",
  ].join("\n");
}

/**
 * Minimal structural view of the Stagehand v3 "understudy" page — just the
 * two primitives we use here. Avoids importing Stagehand's internal Page type
 * (it isn't part of the public surface) while staying type-checked.
 */
type CdpPage = {
  evaluate<R = unknown>(
    fn: string | ((arg: unknown) => R | Promise<R>),
    arg?: unknown,
  ): Promise<R>;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
};

/**
 * URL globs for third-party junk the DOM agent never needs. Tracker / ad /
 * analytics / session-replay hosts plus raw video — NOT fonts, CSS, images,
 * or anything on google's recaptcha / gstatic / cloudflare-challenge paths
 * (so captcha solving and on-page confirmation reads are unaffected).
 * Matched by CDP `Network.setBlockedURLs` (supports `*` wildcards).
 */
const HEAVY_RESOURCE_BLOCKLIST = [
  "*googletagmanager.com*",
  "*google-analytics.com*",
  "*analytics.google.com*",
  "*g.doubleclick.net*",
  "*googlesyndication.com*",
  "*googleadservices.com*",
  "*adservice.google.*",
  "*connect.facebook.net*",
  "*facebook.com/tr*",
  "*hotjar.com*",
  "*hotjar.io*",
  "*static.hotjar.com*",
  "*fullstory.com*",
  "*clarity.ms*",
  "*segment.io*",
  "*cdn.segment.com*",
  "*mixpanel.com*",
  "*amplitude.com*",
  "*intercom.io*",
  "*intercomcdn.com*",
  "*hs-scripts.com*",
  "*hs-analytics.net*",
  "*bat.bing.com*",
  "*snap.licdn.com*",
  "*analytics.tiktok.com*",
  "*sentry.io*",
  "*px.ads.linkedin.com*",
  "*ct.pinterest.com*",
  "*static.ads-twitter.com*",
  "*analytics.twitter.com*",
  "*scorecardresearch.com*",
  "*quantserve.com*",
  "*chartbeat.com*",
  "*nr-data.net*",
  "*js-agent.newrelic.com*",
  "*cdn.optimizely.com*",
  "*qualtrics.com*",
  "*dynamicyield.com*",
  // Live-chat / support widgets — heavy bundles the agent never touches.
  "*widget.intercom.io*",
  "*js.driftt.com*",
  "*static.zdassets.com*",
  "*embed.tawk.to*",
  "*cdn.livechatinc.com*",
  "*client.crisp.chat*",
  // Raw video + embedded players (hero reels, virtual tours). Pure weight.
  "*.mp4*",
  "*.webm*",
  "*.m4v*",
  "*.mov*",
  "*player.vimeo.com*",
  "*youtube.com/embed*",
  "*i.ytimg.com*",
  // Web fonts — the DOM agent reads the accessibility tree's text, never the
  // rendered glyphs, so blocking these only swaps in system fonts (instant)
  // with ZERO functional impact. recaptcha/gstatic serve JS+images, not
  // woff, so captcha solving is unaffected.
  "*.woff*",
  "*.ttf",
  "*.otf",
  "*.eot",
];

/**
 * Images, gated separately behind BROWSER_AGENT_BLOCK_IMAGES. Blocking images
 * is the single biggest page-load win on photo-heavy luxury-hotel sites — the
 * DOM agent doesn't see pixels, so it's free speed DURING the booking. The one
 * cost: the final "Booked ✓" confirmation screenshot renders with broken image
 * placeholders (the confirmation number + text still show fine). Off by default
 * so the proof screenshot stays pristine; flip the env to trade it for speed.
 */
const IMAGE_BLOCKLIST = [
  "*.jpg*",
  "*.jpeg*",
  "*.png*",
  "*.gif*",
  "*.webp*",
  "*.avif*",
  "*.svg*",
];

/**
 * Block heavy third-party resources for the whole run via CDP. Best-effort:
 * if the page doesn't expose CDP or the command fails, we just skip it — the
 * booking still works, only a touch slower. Set BROWSER_AGENT_BLOCK_HEAVY
 * =false to disable entirely.
 */
async function blockHeavyResources(page: unknown): Promise<void> {
  if (optionalEnv("BROWSER_AGENT_BLOCK_HEAVY") === "false") return;
  const cdp = page as CdpPage;
  if (typeof cdp?.sendCDP !== "function") return;
  const urls =
    optionalEnv("BROWSER_AGENT_BLOCK_IMAGES") === "true"
      ? [...HEAVY_RESOURCE_BLOCKLIST, ...IMAGE_BLOCKLIST]
      : HEAVY_RESOURCE_BLOCKLIST;
  try {
    await cdp.sendCDP("Network.enable");
    await cdp.sendCDP("Network.setBlockedURLs", { urls });
  } catch (e) {
    console.warn(
      `[stagehand] heavy-resource block skipped: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Deterministically dismiss a cookie / consent / privacy banner by clicking
 * the accept control in-page — no LLM call. Tries the well-known consent
 * managers by selector first, then any visible button/link whose short label
 * reads Accept / Agree / OK / Allow in EN, IT, ES, FR, DE, or PT. Returns the
 * label/selector it clicked, or null if it found nothing to dismiss (caller
 * then falls back to the LLM act()). Best-effort — never throws.
 */
async function dismissConsentDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const ACCEPT =
        /^(accept all|accept cookies|accept|agree|i agree|allow all|allow cookies|got it|ok|okay|continue|enable all|accetta tutti|accetta|acconsento|accetto|aceptar todo|aceptar|de acuerdo|tout accepter|j.accepte|accepter|alle akzeptieren|akzeptieren|zustimmen|einverstanden|aceitar tudo|aceitar|concordo)$/i;
      const KNOWN = [
        "#onetrust-accept-btn-handler",
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "#CybotCookiebotDialogBodyButtonAccept",
        "#didomi-notice-agree-button",
        "button[data-testid='uc-accept-all-button']",
        "#accept-recommended-btn-handler",
        ".cc-allow",
        ".cookie-accept",
        "#cookie-accept",
        "button[aria-label='Accept all']",
        "button[aria-label='Accept all cookies']",
      ];
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rects = (el as HTMLElement).getClientRects();
        if (!rects || rects.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return (
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          Number(s.opacity || "1") > 0.05
        );
      };
      for (const sel of KNOWN) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          (el as HTMLElement).click();
          return sel;
        }
      }
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, [role=button], a, input[type=button], input[type=submit]",
        ),
      );
      for (const el of nodes) {
        const raw =
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          "";
        const txt = raw.trim();
        if (!txt || txt.length > 40) continue;
        if (ACCEPT.test(txt) && isVisible(el)) {
          el.click();
          return txt;
        }
      }
      return null;
    });
  } catch {
    return null;
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
