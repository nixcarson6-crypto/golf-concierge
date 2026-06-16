/**
 * Skyvern booking runner — an ALTERNATIVE agent engine, selected with
 * BOOKING_ENGINE=skyvern. Steel/Browserbase + Stagehand stay the default and
 * the fallback; this is purely additive.
 *
 * Unlike Stagehand (which we drive over CDP on Steel/Browserbase), Skyvern is
 * a hosted REST agent: we POST a task (start URL + a natural-language goal +
 * the traveler data) to api.skyvern.com, it runs its own vision+LLM agent, and
 * we poll for the result. Skyvern's vision approach is meant to complete
 * complex multi-step forms that defeat a DOM agent.
 *
 * Built "wire-then-verify" (like the RateHawk provider): inert until
 * SKYVERN_API_KEY is set, every call fails LOUD with Skyvern's own response
 * body, and `pnpm check:skyvern` validates the real shapes. Maps Skyvern's
 * terminal status onto our skeptical outcome — NEVER reports "confirmed"
 * without a real confirmation in the extracted data.
 */

import { env, optionalEnv } from "@/lib/env";
import type { RawBookingOutcome } from "./outcome";

const BASE = optionalEnv("SKYVERN_BASE") ?? "https://api.skyvern.com";

export function skyvernConfigured(): boolean {
  return Boolean(optionalEnv("SKYVERN_API_KEY"));
}

export type SkyvernRunnerOptions = {
  startUrl: string;
  /** The full booking instruction (we reuse goal.firstUserMessage). */
  navigationGoal: string;
  /** Structured data the agent fills from (name/email/phone/dates/party…). */
  payload: Record<string, unknown>;
  /** Hard wall-clock for the whole run, ms. */
  timeoutMs: number;
  /** Live progress label → UI. */
  onStep?: (label: string) => void | Promise<void>;
  /** Fired once with the live-view URL so the app can show "Watch live". */
  onSessionReady?: (sessionUrl: string | null) => void | Promise<void>;
};

export type SkyvernRunnerResult = {
  outcome: RawBookingOutcome;
  finalScreenshot: string | null;
  sessionUrl: string | null;
};

type SkyvernRun = {
  run_id?: string;
  task_id?: string;
  status?: string;
  /** Whatever the agent extracted (confirmation #, room, price). */
  output?: unknown;
  extracted_information?: unknown;
  recording_url?: string | null;
  app_url?: string | null;
  failure_reason?: string | null;
  reason?: string | null;
};

function authHeaders(): Record<string, string> {
  return {
    "x-api-key": env("SKYVERN_API_KEY").trim(),
    "Content-Type": "application/json",
  };
}

/** Create the Skyvern task and return its id + a live-view URL. */
async function createRun(opts: SkyvernRunnerOptions): Promise<{
  id: string;
  liveUrl: string | null;
}> {
  const body = {
    // The prompt-style "run task" API: a goal + a start URL + the data.
    prompt: opts.navigationGoal,
    url: opts.startUrl,
    // Stop at the card step — the customer's payment is entered by our own
    // Stripe-issuing flow, never by the agent. (Also stated in the prompt.)
    navigation_payload: opts.payload,
    proxy_location: "RESIDENTIAL",
    // Cap the agent's own loop so a hung run can't outlive our wall-clock.
    max_steps: 40,
  };
  const res = await fetch(`${BASE}/v1/run/tasks`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: SkyvernRun;
  try {
    json = text ? (JSON.parse(text) as SkyvernRun) : {};
  } catch {
    json = { reason: text.slice(0, 300) };
  }
  if (!res.ok) {
    throw new Error(
      `[skyvern] create run → ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  const id = String(json.run_id ?? json.task_id ?? "");
  if (!id) throw new Error(`[skyvern] create run returned no id | ${text.slice(0, 300)}`);
  const liveUrl =
    json.app_url ??
    json.recording_url ??
    `https://app.skyvern.com/tasks/${id}`;
  return { id, liveUrl };
}

/** Poll a run to a terminal status (or our wall-clock). */
async function pollRun(
  id: string,
  deadline: number,
  onStep?: (label: string) => void | Promise<void>,
): Promise<SkyvernRun> {
  const TERMINAL = new Set([
    "completed",
    "failed",
    "terminated",
    "timed_out",
    "canceled",
    "cancelled",
  ]);
  let last: SkyvernRun = {};
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    let res: Response;
    try {
      res = await fetch(`${BASE}/v1/runs/${encodeURIComponent(id)}`, {
        headers: authHeaders(),
      });
    } catch {
      continue; // transient — keep polling until the deadline
    }
    const text = await res.text();
    try {
      last = text ? (JSON.parse(text) as SkyvernRun) : last;
    } catch {
      continue;
    }
    const status = (last.status ?? "").toLowerCase();
    if (status) await onStep?.(skyvernProgress(status));
    if (TERMINAL.has(status)) return last;
  }
  return { ...last, status: last.status ?? "timed_out" };
}

function skyvernProgress(status: string): string {
  switch (status) {
    case "created":
    case "queued":
      return "Queued — Skyvern is starting…";
    case "running":
      return "Skyvern is working through the booking…";
    default:
      return "Finishing up…";
  }
}

/** Map Skyvern's terminal status + extracted data onto our skeptical outcome. */
function toOutcome(run: SkyvernRun): RawBookingOutcome {
  const status = (run.status ?? "").toLowerCase();
  const extracted = JSON.stringify(
    run.output ?? run.extracted_information ?? {},
  ).toLowerCase();
  const failure = (run.failure_reason ?? run.reason ?? "").toLowerCase();

  // Real confirmation in the extracted data → confirmed. Be strict.
  const hasConfirmation =
    /confirmation\s*(number|code|#|id)|reservation\s*(number|code|#|id)|booked|"confirmed"\s*:\s*true/.test(
      extracted,
    );

  if (status === "completed") {
    if (hasConfirmation) {
      return { status: "confirmed", message: digest(run) };
    }
    // Completed but no confirmation — most likely reached the card step.
    return { status: "needs_review", message: digest(run) };
  }

  if (status === "terminated") {
    // Skyvern "terminates" when it can't finish — often the card step with no
    // card, which is a clean needs_review, not a hard failure.
    if (/payment|card|checkout|review/.test(failure + extracted)) {
      return { status: "needs_review", message: digest(run) };
    }
    return { status: "failed", failureReason: "ambiguous", message: digest(run) };
  }

  if (status === "timed_out") {
    return { status: "failed", failureReason: "timeout", message: digest(run) };
  }
  // failed / canceled / unknown
  return { status: "failed", failureReason: "ambiguous", message: digest(run) };
}

function digest(run: SkyvernRun): string {
  const out =
    typeof run.output === "string"
      ? run.output
      : run.output
        ? JSON.stringify(run.output)
        : typeof run.extracted_information === "string"
          ? run.extracted_information
          : run.extracted_information
            ? JSON.stringify(run.extracted_information)
            : "";
  const reason = run.failure_reason ?? run.reason ?? "";
  return (out || reason || "Skyvern run finished.").slice(0, 600);
}

export async function runSkyvernBooking(
  opts: SkyvernRunnerOptions,
): Promise<SkyvernRunnerResult> {
  if (!skyvernConfigured()) {
    return {
      outcome: {
        status: "failed",
        failureReason: "ambiguous",
        message: "Skyvern not configured (SKYVERN_API_KEY missing).",
      },
      finalScreenshot: null,
      sessionUrl: null,
    };
  }
  const deadline = Date.now() + opts.timeoutMs;
  try {
    await opts.onStep?.("Handing the booking to Skyvern…");
    const { id, liveUrl } = await createRun(opts);
    console.log(`[skyvern] ✓ run ${id} created (live: ${liveUrl ?? "n/a"})`);
    await opts.onSessionReady?.(liveUrl);
    const run = await pollRun(id, deadline, opts.onStep);
    console.log(`[skyvern] run ${id} finished status=${run.status ?? "?"}`);
    return {
      outcome: toOutcome(run),
      finalScreenshot: null,
      sessionUrl: liveUrl,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[skyvern] run failed: ${msg}`);
    return {
      outcome: {
        status: "failed",
        // ambiguous IS retryable — a transient Skyvern/API error can clear.
        failureReason: "ambiguous",
        message: `Skyvern couldn't complete the booking (${msg}).`,
      },
      finalScreenshot: null,
      sessionUrl: null,
    };
  }
}
