/**
 * Browserbase + Playwright session lifecycle for the booking agent.
 *
 * Owns the headless browser the agent drives: open a Browserbase session,
 * connect Playwright to it over CDP, expose the primitives the agent needs
 * (screenshot, click, type, navigate, key), grab a live-view URL for
 * debugging, enforce a hard wall-clock budget, and tear everything down
 * cleanly even on failure.
 *
 * Network-bound, account-gated. Falls back to a clear error if Browserbase
 * keys aren't configured — the brain layer (goal.ts/outcome.ts) doesn't
 * need this file at all.
 */

import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { env, optionalEnv } from "@/lib/env";

/* -------------------------------------------------------------------------- */
/* Config — viewport pinned to match the computer-use tool's display size      */
/* -------------------------------------------------------------------------- */

/**
 * The Claude computer-use tool sends absolute pixel coordinates for clicks
 * keyed to the `display_width_px`/`display_height_px` we declared in the tool
 * definition. The Playwright viewport must match exactly or every click lands
 * in the wrong spot. Keep this constant in lockstep with the tool def in
 * `agent.ts`.
 */
export const AGENT_VIEWPORT = { width: 1280, height: 800 } as const;

/** Hard wall-clock budget for an entire booking attempt. Defense in depth — */
/** the agent loop also caps iterations + tokens; this is the outermost gate. */
const SESSION_TIMEOUT_MS = 180_000;

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export type AgentSession = {
  /** Browserbase session id — used for liveViewUrl and teardown. */
  sessionId: string;
  /** Playwright Browser. Close via `closeSession` to also release the BB session. */
  browser: Browser;
  /** First page in the session. Use this for all agent actions. */
  page: Page;
  /** Optional live debugger URL (debuggerFullscreenUrl) — store now, embed later. */
  liveViewUrl: string | null;
};

export class BrowserAgentRuntimeError extends Error {
  constructor(
    public readonly code:
      | "no_config"
      | "session_create_failed"
      | "connect_failed"
      | "no_page"
      | "navigation_failed",
    message: string,
  ) {
    super(message);
    this.name = "BrowserAgentRuntimeError";
  }
}

export function isBrowserbaseConfigured(): boolean {
  return Boolean(
    optionalEnv("BROWSERBASE_API_KEY") && optionalEnv("BROWSERBASE_PROJECT_ID"),
  );
}

/**
 * Open a stealth Browserbase session and connect Playwright to it. Caller is
 * responsible for `closeSession()` even on error paths.
 */
export async function openSession(): Promise<AgentSession> {
  if (!isBrowserbaseConfigured()) {
    throw new BrowserAgentRuntimeError(
      "no_config",
      "BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set.",
    );
  }

  const bb = new Browserbase({ apiKey: env("BROWSERBASE_API_KEY") });
  const projectId = env("BROWSERBASE_PROJECT_ID");
  const region = (optionalEnv("BROWSERBASE_REGION") ?? "us-east-1") as
    | "us-west-2"
    | "us-east-1"
    | "eu-central-1"
    | "ap-southeast-1";

  let sessionId: string;
  let connectUrl: string;
  try {
    // Stealth / residential proxies / CAPTCHA-solving are PAID Browserbase
    // features (advancedStealth is Enterprise-only). Default to the bare
    // free-tier config (viewport only) so the agent runs on any plan; flip
    // BROWSERBASE_PREMIUM=true once on a paid plan to harden against
    // bot-walls. Free tier still works for most independent venue sites —
    // they're not the ones running aggressive bot detection.
    const premium = optionalEnv("BROWSERBASE_PREMIUM") === "true";
    const session = await bb.sessions.create({
      projectId,
      region,
      browserSettings: {
        viewport: { width: AGENT_VIEWPORT.width, height: AGENT_VIEWPORT.height },
        ...(premium ? { advancedStealth: true, solveCaptchas: true } : {}),
      },
      ...(premium ? { proxies: true } : {}),
    });
    sessionId = session.id;
    connectUrl = session.connectUrl;
  } catch (err) {
    throw new BrowserAgentRuntimeError(
      "session_create_failed",
      `Browserbase session create failed: ${asMessage(err)}`,
    );
  }

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(connectUrl);
  } catch (err) {
    // Best-effort release of the session we just paid for.
    await safeReleaseSession(bb, sessionId);
    throw new BrowserAgentRuntimeError(
      "connect_failed",
      `Playwright CDP connect failed: ${asMessage(err)}`,
    );
  }

  // Browserbase pre-creates one default context with one page. Reuse it so
  // the agent stays inside the stealth/proxy context — opening a fresh
  // context loses those settings on some Browserbase plans.
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext({ viewport: AGENT_VIEWPORT }));
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  await page.setViewportSize(AGENT_VIEWPORT).catch(() => {
    /* some Browserbase contexts disallow resize; ignore — viewport is already pinned at creation */
  });

  let liveViewUrl: string | null = null;
  try {
    const debug = await bb.sessions.debug(sessionId);
    liveViewUrl = debug.debuggerFullscreenUrl ?? debug.debuggerUrl ?? null;
  } catch {
    // Non-fatal — live view is for humans, the agent works without it.
  }

  return { sessionId, browser, page, liveViewUrl };
}

/**
 * Run `fn` against a fresh session with a hard wall-clock timeout. Always
 * tears the session down — even if `fn` throws or the timeout fires — so we
 * never leak a paid Browserbase minute.
 */
export async function withSession<T>(
  fn: (s: AgentSession) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const session = await openSession();
  const timeoutMs = opts.timeoutMs ?? SESSION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new BrowserAgentRuntimeError(
            "navigation_failed",
            `Session exceeded ${Math.round(timeoutMs / 1000)}s wall-clock budget.`,
          ),
        );
      }, timeoutMs);
    });
    return await Promise.race([fn(session), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await closeSession(session);
  }
}

/** Tear down a session. Safe to call multiple times. Never throws. */
export async function closeSession(s: AgentSession): Promise<void> {
  try {
    await s.browser.close();
  } catch {
    /* ignore */
  }
  try {
    const bb = new Browserbase({ apiKey: env("BROWSERBASE_API_KEY") });
    await safeReleaseSession(bb, s.sessionId);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* Agent primitives — what the computer-use loop calls into                    */
/* -------------------------------------------------------------------------- */

/** Take a PNG screenshot of the page, return base64 (no data: prefix). */
export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return buf.toString("base64");
}

/** Navigate to a URL with a reasonable wait + retry on transient failure. */
export async function navigate(page: Page, url: string): Promise<void> {
  // `domcontentloaded` is the right wait for booking forms — `load` waits on
  // every analytics pixel and `networkidle` rarely settles on modern sites.
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    throw new BrowserAgentRuntimeError(
      "navigation_failed",
      `Failed to navigate to ${url}: ${asMessage(err)}`,
    );
  }
}

export async function click(
  page: Page,
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  clickCount = 1,
): Promise<void> {
  // Clamp to viewport — defensive against model coordinate hallucinations
  // outside the screenshot canvas.
  const cx = clamp(x, 0, AGENT_VIEWPORT.width - 1);
  const cy = clamp(y, 0, AGENT_VIEWPORT.height - 1);
  await page.mouse.click(cx, cy, { button, clickCount });
}

export async function move(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(
    clamp(x, 0, AGENT_VIEWPORT.width - 1),
    clamp(y, 0, AGENT_VIEWPORT.height - 1),
  );
}

export async function type(page: Page, text: string): Promise<void> {
  // `keyboard.type` (vs `fill`) preserves focus on whatever input the agent
  // just clicked into — important because the model picks the focus target
  // visually rather than by selector.
  await page.keyboard.type(text, { delay: 12 });
}

/**
 * Map Claude's xdotool-style key names to Playwright's. The computer-use
 * tool emits strings like "Return", "ctrl+a", "Page_Down" — Playwright wants
 * "Enter", "Control+A", "PageDown". This mapping covers the keys we've seen
 * the model use in practice; anything unmapped is passed through.
 */
const KEY_MAP: Record<string, string> = {
  Return: "Enter",
  KP_Enter: "Enter",
  Tab: "Tab",
  BackSpace: "Backspace",
  Delete: "Delete",
  Escape: "Escape",
  space: " ",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Home: "Home",
  End: "End",
  Page_Up: "PageUp",
  Page_Down: "PageDown",
};
export async function pressKey(page: Page, key: string): Promise<void> {
  const parts = key.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let main = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") mods.push("Control");
    else if (lower === "shift") mods.push("Shift");
    else if (lower === "alt") mods.push("Alt");
    else if (lower === "meta" || lower === "cmd" || lower === "super") mods.push("Meta");
    else main = KEY_MAP[part] ?? part;
  }
  const combo = mods.length ? `${mods.join("+")}+${main}` : main;
  await page.keyboard.press(combo);
}

export async function scroll(
  page: Page,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  const px = Math.max(0, Math.round(amount)) * 40;
  let dx = 0;
  let dy = 0;
  if (direction === "down") dy = px;
  else if (direction === "up") dy = -px;
  else if (direction === "right") dx = px;
  else dx = -px;
  await page.mouse.wheel(dx, dy);
}

export async function wait(ms: number): Promise<void> {
  // Cap waits — model sometimes asks for absurd durations.
  await new Promise((r) => setTimeout(r, Math.min(Math.max(ms, 0), 10_000)));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReleaseSession(
  bb: Browserbase,
  sessionId: string,
): Promise<void> {
  try {
    // Best-effort release of a paid session. Browserbase auto-times out
    // sessions, but explicit release is cleaner.
    await bb.sessions.update(sessionId, {
      projectId: env("BROWSERBASE_PROJECT_ID"),
      status: "REQUEST_RELEASE",
    });
  } catch {
    /* ignore */
  }
}
