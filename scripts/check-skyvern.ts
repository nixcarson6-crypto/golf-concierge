/**
 * Skyvern integration validation.
 *
 *   pnpm check:skyvern
 *
 * Creates ONE tiny read-only task (open example.com, extract the page title),
 * polls it to completion, and prints Skyvern's RAW responses — so we can see
 * the real endpoint + field shapes and adjust the runner if they differ from
 * what was wired. No booking is placed. Needs SKYVERN_API_KEY in .env.local.
 */

import { skyvernConfigured, runSkyvernBooking } from "../src/lib/bookings/browser-agent/skyvern-runner";

async function main() {
  if (!skyvernConfigured()) {
    console.error("✗ SKYVERN_API_KEY not set in .env.local — add it and retry.");
    process.exit(1);
  }
  console.log("→ Creating a tiny Skyvern test task (example.com)…");
  const result = await runSkyvernBooking({
    startUrl: "https://example.com",
    navigationGoal:
      "Open the page and read its main heading. Do not click anything. Report the heading text.",
    payload: {},
    timeoutMs: 120_000,
    onStep: (label) => console.log(`   · ${label}`),
    onSessionReady: (url) => console.log(`   live view: ${url ?? "n/a"}`),
  });
  console.log("\n=== OUTCOME ===");
  console.log(JSON.stringify(result.outcome, null, 2));
  console.log(`live view: ${result.sessionUrl ?? "n/a"}`);
  if (result.outcome.status === "failed") {
    console.log(
      "\nIf this failed on the API shape (404/400/no id), the endpoint or field names differ from what was wired — paste the error above and I'll adjust createRun/pollRun.",
    );
  } else {
    console.log("\n✓ Skyvern reachable end-to-end. The booking runner is wired.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
