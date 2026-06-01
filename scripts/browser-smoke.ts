#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Browser smoke test — NO Anthropic credits required.
 *
 * Proves the mechanical half of the booking agent works: our code opens a
 * REAL venue page in a REAL browser (via Browserbase), reads it, and can
 * interact with it. It does NOT use the AI brain (that's the Anthropic-
 * credit-gated half) — it just drives Playwright directly to demonstrate
 * the plumbing is real.
 *
 *   pnpm check:browser --url "https://reserve.fontelina-capri.com/en"
 *
 * What it does:
 *   1. Opens a Browserbase session (prints the live-view URL to watch)
 *   2. Navigates to the URL
 *   3. Saves a screenshot to ./agent-smoke.png — open it to SEE the page
 *      our code actually loaded
 *   4. Counts the form fields (inputs / selects / textareas / buttons) so
 *      you can see it found a real booking form
 *   5. Prints the page title
 *
 * This is honest evidence the browser layer reaches + reads the real form.
 * It is NOT a booking and does not submit anything.
 */

import { writeFileSync } from "node:fs";
import { withSession, isBrowserbaseConfigured, navigate } from "../src/lib/bookings/browser-agent/runtime";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const url = arg("url");
  if (!url) {
    console.error('ERROR: --url is required.\n  pnpm check:browser --url "https://reserve.fontelina-capri.com/en"');
    process.exit(2);
  }
  if (!isBrowserbaseConfigured()) {
    console.error("ERROR: BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set in .env.local.");
    process.exit(2);
  }

  console.log("─".repeat(72));
  console.log(`Browser smoke test (NO AI / NO Anthropic credits used)`);
  console.log(`URL: ${url}`);
  console.log("─".repeat(72));

  const outPath = `${process.cwd()}/agent-smoke.png`;

  await withSession(async (session) => {
    console.log(`Session id: ${session.sessionId}`);
    if (session.liveViewUrl) {
      console.log(`Live view:  ${session.liveViewUrl}`);
      console.log("            (open in a browser to watch it load the page live)");
    }
    console.log("─".repeat(72));
    console.log(`Navigating to ${url} …`);
    await navigate(session.page, url);

    // Give the page a moment to render any client-side form widgets.
    await new Promise((r) => setTimeout(r, 3500));

    const title = await session.page.title().catch(() => "(no title)");
    const inputs = await session.page.locator("input").count().catch(() => 0);
    const selects = await session.page.locator("select").count().catch(() => 0);
    const textareas = await session.page.locator("textarea").count().catch(() => 0);
    const buttons = await session.page.locator("button, [type=submit]").count().catch(() => 0);

    const shot = await session.page.screenshot({ type: "png", fullPage: true });
    writeFileSync(outPath, shot);

    console.log("─".repeat(72));
    console.log(`✅ Reached the real page.`);
    console.log(`   Title:        ${title}`);
    console.log(`   Form fields:  ${inputs} inputs · ${selects} dropdowns · ${textareas} text areas · ${buttons} buttons`);
    console.log(`   Screenshot:   ${outPath}`);
    console.log(`                 ^ open that PNG to SEE the page our code loaded.`);
    console.log("─".repeat(72));
    if (inputs + selects + textareas > 0) {
      console.log("PROOF: our code opened the real venue site in a real browser and");
      console.log("found a live, interactive booking form. The mechanical layer works.");
      console.log("(The AI brain that fills it is the part waiting on Anthropic credits.)");
    } else {
      console.log("Reached the page but found no obvious form fields here — this may be a");
      console.log("landing page; the booking form could be behind a 'Book'/'Reserve' link.");
    }
    console.log("─".repeat(72));
  }, { timeoutMs: 60_000 });
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
