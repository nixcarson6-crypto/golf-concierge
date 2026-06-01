/**
 * The Claude computer-use loop that drives the Browserbase session.
 *
 * Wires Claude (via the existing `anthropic()` client) to the Playwright
 * primitives in `runtime.ts`. The model "sees" the page via screenshots and
 * "acts" via tool calls (left_click, type, key, scroll, …). On each turn we
 * dispatch the tool, do the action, return a fresh screenshot, and loop.
 *
 * Two custom Anthropic tools alongside the built-in `computer`:
 *  - `report_outcome` — the ONLY way the model is allowed to finish, with
 *    the on-screen confirmation evidence. Schema is the authoritative one
 *    from `outcome.ts` so the brain's verifier knows exactly what it gets.
 *  - `request_payment_card` — the model calls this when it reaches the
 *    vendor's card form; we hand back a single-use virtual card just-in-time.
 *    In the no-Stripe MVP path it returns a fail-safe signal that the model
 *    must turn into a `needs_review` outcome (no card touched, no booking).
 *
 * Hard caps everywhere — max iterations, per-call max_tokens, total token
 * budget, wall-clock timeout — so a runaway model can never spin forever.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/ai/client";
import { optionalEnv } from "@/lib/env";
import type { Page } from "playwright-core";
import {
  AGENT_VIEWPORT,
  click,
  move,
  navigate,
  pressKey,
  scroll,
  screenshot,
  type,
  wait,
} from "./runtime";
import {
  bookingOutcomeSchema,
  reportOutcomeToolInputSchema,
  type RawBookingOutcome,
} from "./outcome";

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

const COMPUTER_USE_BETA = "computer-use-2025-11-24" as const;
const COMPUTER_TOOL_TYPE = "computer_20250124" as const;

/** Defaults. All overridable via the loop options for low-value-booking tunings. */
const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MAX_TOKENS_PER_TURN = 1536;
/** Approximate ceiling on total INPUT tokens consumed by the loop. */
const DEFAULT_INPUT_TOKEN_BUDGET = 200_000;

/* -------------------------------------------------------------------------- */
/* Card-provider contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Just-in-time payment-card provider invoked when the model calls
 * `request_payment_card`. The runtime never holds card numbers in
 * memory longer than this call; for the no-Stripe MVP path we pass
 * `unavailableCardProvider` which makes the agent gracefully bail out.
 */
export type CardProvider = () => Promise<
  | {
      status: "ok";
      number: string;
      expMonth: number;
      expYear: number;
      cvc: string;
      cardholderName?: string;
      billingZip?: string;
    }
  | { status: "unavailable"; reason: string }
>;

/** No-Stripe MVP default — the agent is told payment isn't wired up yet. */
export const unavailableCardProvider: CardProvider = async () => ({
  status: "unavailable",
  reason:
    "Payment is not yet enabled on this account. Stop entering payment, do not fabricate a card, and call report_outcome with status 'needs_review' so a human can complete this booking.",
});

/* -------------------------------------------------------------------------- */
/* Loop                                                                        */
/* -------------------------------------------------------------------------- */

export type AgentStep = {
  iteration: number;
  /** Human label for the live progress UI ("Filling reservation details…"). */
  label: string;
};

export type RunAgentOptions = {
  page: Page;
  system: string;
  firstUserMessage: string;
  /** Provider for the just-in-time payment card. Default: unavailable (MVP). */
  cardProvider?: CardProvider;
  /** Called on every meaningful step — wire to updateProgress() for live UI. */
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** Override model. Default reads ANTHROPIC_MODEL_COMPUTER_USE / DEFAULT_MODEL. */
  model?: string;
  /** Override max iterations. */
  maxIterations?: number;
  /** Override input-token budget. */
  inputTokenBudget?: number;
};

export type AgentRunResult = {
  outcome: RawBookingOutcome;
  /** How many tool-use iterations the loop went through. */
  iterations: number;
  /** Rough total INPUT tokens (Anthropic usage.input_tokens summed). */
  inputTokensUsed: number;
  /** Rough total OUTPUT tokens. */
  outputTokensUsed: number;
  /** Final screenshot (base64 PNG, no data: prefix) for evidence/debug. */
  finalScreenshot: string | null;
};

/**
 * Run the agent loop until it calls `report_outcome` (terminal) OR we hit
 * a safety cap. Caps always produce a structured `RawBookingOutcome` — we
 * NEVER throw on a "the agent didn't finish" — the brain treats it the
 * same as any other ambiguous case.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const client = anthropic();
  const model = opts.model ?? optionalEnv("ANTHROPIC_MODEL_COMPUTER_USE") ?? DEFAULT_MODEL;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const inputTokenBudget = opts.inputTokenBudget ?? DEFAULT_INPUT_TOKEN_BUDGET;
  const cardProvider = opts.cardProvider ?? unavailableCardProvider;

  // Prime the conversation with the goal + an initial screenshot so the
  // model has visual context from turn 1. The screenshot is treated as the
  // result of an implicit "screenshot" action — saves one full round trip.
  const initialShot = await screenshot(opts.page).catch(() => null);
  const initialContent: Anthropic.ContentBlockParam[] = [
    { type: "text", text: opts.firstUserMessage },
  ];
  if (initialShot) {
    initialContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: initialShot },
    });
  }
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: initialContent },
  ];

  let inputTokensUsed = 0;
  let outputTokensUsed = 0;
  let lastScreenshot: string | null = initialShot;

  const tools = buildTools();
  // Cache the system prompt + tool defs. They're identical across every turn
  // in the loop — the cache cuts per-turn cost meaningfully (~10x cheaper on
  // reads vs writes), exactly the same pattern orchestrator.ts uses.
  const systemParam: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: opts.system,
      cache_control: { type: "ephemeral" },
    },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (inputTokensUsed > inputTokenBudget) {
      return makeCapOutcome(
        "timeout",
        `Token budget (${inputTokenBudget}) exhausted after ${iteration - 1} iterations.`,
        iteration - 1,
        inputTokensUsed,
        outputTokensUsed,
        lastScreenshot,
      );
    }

    let response: Anthropic.Message;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: DEFAULT_MAX_TOKENS_PER_TURN,
        system: systemParam,
        tools,
        messages,
        betas: [COMPUTER_USE_BETA],
      });
    } catch (err) {
      return makeCapOutcome(
        "ambiguous",
        `Anthropic API call failed at iteration ${iteration}: ${asMessage(err)}`,
        iteration - 1,
        inputTokensUsed,
        outputTokensUsed,
        lastScreenshot,
      );
    }

    inputTokensUsed += response.usage.input_tokens ?? 0;
    outputTokensUsed += response.usage.output_tokens ?? 0;

    // Persist the assistant turn so the next request has full context.
    messages.push({ role: "assistant", content: response.content });

    // Find any terminal report_outcome call first — that ends the loop.
    const terminal = findReportOutcome(response.content);
    if (terminal) {
      await safeStep(opts.onStep, {
        iteration,
        label: terminal.parsed.message?.slice(0, 80) || "Booking finished.",
      });
      return {
        outcome: terminal.parsed,
        iterations: iteration,
        inputTokensUsed,
        outputTokensUsed,
        finalScreenshot: lastScreenshot,
      };
    }

    // Otherwise: dispatch every tool_use block in this turn against
    // Playwright, append tool_result blocks, loop again. The model is
    // allowed to issue multiple tool_use blocks per turn.
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // No tool calls and no report_outcome — model is stuck / hallucinating
    // a prose answer. End loop visibly.
    if (toolUses.length === 0) {
      return makeCapOutcome(
        "ambiguous",
        `Agent stopped issuing tool calls without calling report_outcome (stop_reason=${response.stop_reason}).`,
        iteration,
        inputTokensUsed,
        outputTokensUsed,
        lastScreenshot,
      );
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const { result, screenshotAfter, stepLabel } = await dispatchTool(
        use,
        opts.page,
        cardProvider,
      );
      if (stepLabel) {
        await safeStep(opts.onStep, { iteration, label: stepLabel });
      }
      if (screenshotAfter) lastScreenshot = screenshotAfter;
      toolResults.push(result);
    }

    messages.push({ role: "user", content: toolResults });
  }

  return makeCapOutcome(
    "timeout",
    `Hit max iterations (${maxIterations}) without report_outcome.`,
    maxIterations,
    inputTokensUsed,
    outputTokensUsed,
    lastScreenshot,
  );
}

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                           */
/* -------------------------------------------------------------------------- */

function buildTools(): Anthropic.Beta.Messages.BetaToolUnion[] {
  return [
    {
      type: COMPUTER_TOOL_TYPE,
      name: "computer",
      display_width_px: AGENT_VIEWPORT.width,
      display_height_px: AGENT_VIEWPORT.height,
      display_number: 1,
    },
    {
      name: "report_outcome",
      description:
        "Call this EXACTLY ONCE to finish the booking attempt. status must be 'confirmed' ONLY if a confirmation/order/reservation number is visible on screen, or there is an explicit 'your reservation is confirmed' screen — quote it in confirmationEvidence. Otherwise use 'failed' (with a failureReason) or 'needs_review'.",
      input_schema: reportOutcomeToolInputSchema as unknown as Anthropic.Tool.InputSchema,
    },
    {
      name: "request_payment_card",
      description:
        "Call this ONLY when you have navigated to the legitimate checkout/payment step of the named venue and a card-entry form is visible. You'll receive a real card number, expiry, and CVC to enter exactly. Do NOT call this for any other reason. If the response says 'unavailable', stop entering payment immediately and call report_outcome with status 'needs_review'.",
      input_schema: {
        type: "object",
        properties: {
          merchantOnPage: {
            type: "string",
            description:
              "The merchant name shown on the checkout page right now (helps audit that we're paying the correct venue).",
          },
          expectedTotalCents: {
            type: "integer",
            description: "The total being charged, in cents.",
          },
        },
        required: ["merchantOnPage", "expectedTotalCents"],
      } as unknown as Anthropic.Tool.InputSchema,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Tool dispatch                                                              */
/* -------------------------------------------------------------------------- */

type Dispatched = {
  result: Anthropic.ToolResultBlockParam;
  /** Returned when the action ran the page — used to refresh lastScreenshot. */
  screenshotAfter: string | null;
  /** Short human label for the live UI; null when the action isn't notable. */
  stepLabel: string | null;
};

async function dispatchTool(
  use: Anthropic.ToolUseBlock,
  page: Page,
  cardProvider: CardProvider,
): Promise<Dispatched> {
  // --- request_payment_card ------------------------------------------------
  if (use.name === "request_payment_card") {
    const card = await cardProvider();
    if (card.status === "ok") {
      // Return ONLY the digits/expiry/cvc the agent needs to type. We do
      // not log this anywhere — string is constructed and immediately
      // sent back as a tool_result, lifetime <1ms in memory.
      const payload = {
        status: "ok" as const,
        number: card.number,
        expiry: `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`,
        cvc: card.cvc,
        cardholderName: card.cardholderName ?? null,
        billingZip: card.billingZip ?? null,
        instruction:
          "Enter exactly these values into the card fields. Submit the form once. If it's declined, call report_outcome with failureReason 'declined_card'.",
      };
      return {
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
        screenshotAfter: null,
        stepLabel: "Entering payment…",
      };
    }
    return {
      result: {
        type: "tool_result",
        tool_use_id: use.id,
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "unavailable", reason: card.reason }),
          },
        ],
      },
      screenshotAfter: null,
      stepLabel: "Payment unavailable — handing back to a human.",
    };
  }

  // --- computer (xdotool-style action set) ---------------------------------
  if (use.name === "computer") {
    const input = (use.input ?? {}) as Record<string, unknown>;
    const action = String(input.action ?? "");
    try {
      switch (action) {
        case "screenshot": {
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: null,
          };
        }
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click": {
          const [x, y] = coord(input.coordinate);
          const button =
            action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
          const count = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
          await click(page, x, y, button, count);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: action === "left_click" ? "Click" : action,
          };
        }
        case "mouse_move": {
          const [x, y] = coord(input.coordinate);
          await move(page, x, y);
          return {
            result: textResult(use.id, "moved"),
            screenshotAfter: null,
            stepLabel: null,
          };
        }
        case "type": {
          const text = String(input.text ?? "");
          await type(page, text);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: text.length > 0 ? `Typing "${preview(text)}"` : "Typing…",
          };
        }
        case "key": {
          const text = String(input.text ?? "");
          await pressKey(page, text);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: `Key ${text}`,
          };
        }
        case "scroll": {
          const direction = (input.scroll_direction as string) ?? "down";
          const amount = Number(input.scroll_amount ?? 3);
          await scroll(page, direction as "up" | "down" | "left" | "right", amount);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: `Scrolling ${direction}`,
          };
        }
        case "wait": {
          const dur = Number(input.duration ?? 1) * 1000;
          await wait(dur);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: null,
          };
        }
        case "navigate":
        case "goto":
        case "open_url": {
          const url = String(input.url ?? "");
          if (url) await navigate(page, url);
          const shot = await screenshot(page);
          return {
            result: imageResult(use.id, shot),
            screenshotAfter: shot,
            stepLabel: url ? `Opening ${shortHost(url)}` : "Navigating…",
          };
        }
        default: {
          // Unknown action — return the screenshot so the model can replan,
          // and an error string so it knows we couldn't run it.
          const shot = await screenshot(page).catch(() => null);
          return {
            result: {
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: [
                { type: "text", text: `unsupported computer action: ${action}` },
              ],
            },
            screenshotAfter: shot,
            stepLabel: null,
          };
        }
      }
    } catch (err) {
      const shot = await screenshot(page).catch(() => null);
      return {
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: [{ type: "text", text: asMessage(err) }],
        },
        screenshotAfter: shot,
        stepLabel: null,
      };
    }
  }

  // --- report_outcome is handled by findReportOutcome BEFORE dispatch ------
  // (Reaching here means it appeared mixed with other tool_use blocks, which
  // is unexpected. Return a soft error so the model retries terminating.)
  return {
    result: {
      type: "tool_result",
      tool_use_id: use.id,
      is_error: true,
      content: [
        {
          type: "text",
          text: "report_outcome must be the only tool call in your final turn. Stop other actions and call it alone.",
        },
      ],
    },
    screenshotAfter: null,
    stepLabel: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function findReportOutcome(
  blocks: Anthropic.ContentBlock[],
): { parsed: RawBookingOutcome } | null {
  for (const b of blocks) {
    if (b.type !== "tool_use" || b.name !== "report_outcome") continue;
    const parsed = bookingOutcomeSchema.safeParse(b.input);
    if (parsed.success) return { parsed: parsed.data };
    // Schema failure — coerce to a needs_review with the raw error so the
    // brain's verifyOutcome can still downgrade it safely.
    return {
      parsed: {
        status: "needs_review",
        message: `report_outcome validation failed: ${parsed.error.message.slice(0, 200)}`,
      },
    };
  }
  return null;
}

function makeCapOutcome(
  reason: "timeout" | "ambiguous",
  message: string,
  iterations: number,
  inputTokensUsed: number,
  outputTokensUsed: number,
  finalScreenshot: string | null,
): AgentRunResult {
  return {
    outcome: {
      status: "failed",
      failureReason: reason,
      message,
    },
    iterations,
    inputTokensUsed,
    outputTokensUsed,
    finalScreenshot,
  };
}

function coord(c: unknown): [number, number] {
  if (Array.isArray(c) && c.length >= 2) {
    return [Number(c[0]) || 0, Number(c[1]) || 0];
  }
  return [0, 0];
}

function imageResult(
  id: string,
  base64: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: base64 },
      },
    ],
  };
}

function textResult(id: string, text: string): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: [{ type: "text", text }],
  };
}

function preview(s: string, max = 40): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

async function safeStep(
  onStep: ((s: AgentStep) => void | Promise<void>) | undefined,
  step: AgentStep,
): Promise<void> {
  if (!onStep) return;
  try {
    await onStep(step);
  } catch {
    /* never let progress reporting break the loop */
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
