#!/usr/bin/env node
/* eslint-disable no-console */
export {};
/**
 * Sanity-check the Uber Guest Rides credentials in .env.local. Run with:
 *
 *   pnpm check:uber
 *
 * Mints an OAuth access token using your client_id/client_secret and
 * prints PASS/FAIL with the exact reason Uber rejected if it failed.
 * Mirrors the pattern of pnpm check:env / pnpm check:places.
 */

const clientId = process.env.UBER_CLIENT_ID;
const clientSecret = process.env.UBER_CLIENT_SECRET;
const env = (process.env.UBER_ENV ?? "sandbox").toLowerCase();

if (!clientId || !clientSecret) {
  console.error(
    "❌ UBER_CLIENT_ID and/or UBER_CLIENT_SECRET are not set in .env.local",
  );
  console.error("");
  console.error("Fix: get them from https://developer.uber.com/dashboard");
  console.error("Add to .env.local:");
  console.error("  UBER_CLIENT_ID=...");
  console.error("  UBER_CLIENT_SECRET=...");
  process.exit(1);
}

console.log(
  `🔑 client_id ending in …${clientId.slice(-6)} (length ${clientId.length})`,
);
console.log(`🌍 UBER_ENV=${env}`);

async function main() {
  const body = new URLSearchParams({
    client_id: clientId!,
    client_secret: clientSecret!,
    grant_type: "client_credentials",
    scope: "guests.trips",
  });

  const res = await fetch("https://auth.uber.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ Uber rejected the token request (HTTP ${res.status}):`);
    console.error(
      text.replace(clientId!, "[REDACTED_ID]").replace(clientSecret!, "[REDACTED_SECRET]"),
    );
    console.error("");
    diagnose(res.status, text);
    process.exit(2);
  }

  type Tok = { access_token?: string; expires_in?: number; scope?: string };
  const json = JSON.parse(text) as Tok;
  if (!json.access_token) {
    console.error("⚠️  Auth returned 200 but no access_token in body:");
    console.error(text);
    process.exit(2);
  }

  console.log(
    `✅ Token minted. Scope: "${json.scope ?? "(unknown)"}", expires in ${json.expires_in ?? "?"}s.`,
  );
  if (!json.scope || !json.scope.includes("guests.trips")) {
    console.warn(
      "⚠️  Token does NOT include guests.trips scope — Guest Rides API calls will 403. Your app needs Central API access (request via Uber for Business).",
    );
  } else {
    console.log(
      "🎉 Guest Rides scope is present. Sandbox calls should work immediately.",
    );
  }
}

function diagnose(_status: number, body: string) {
  const b = body.toLowerCase();
  if (b.includes("invalid_client") || b.includes("invalid client")) {
    console.error(
      "👉 FIX: Client ID or Client Secret is wrong. Re-copy from\n" +
        "   https://developer.uber.com/dashboard and paste into .env.local.\n" +
        "   Don't include quotes or trailing whitespace.",
    );
  } else if (b.includes("invalid_scope") || b.includes("scope")) {
    console.error(
      "👉 FIX: The app doesn't have guests.trips scope yet. That's an\n" +
        "   Uber for Business grant — chase the Central API approval\n" +
        "   request you already submitted. Sandbox typically still works\n" +
        "   for basic OAuth even without it; production Guest Rides needs it.",
    );
  } else if (b.includes("unauthorized_client")) {
    console.error(
      "👉 FIX: The app isn't authorized for client_credentials grant.\n" +
        "   Check the app config at https://developer.uber.com/dashboard.",
    );
  } else {
    console.error(
      "👉 Not a known pattern — paste the error above to your dev pair.",
    );
  }
}

main().catch((err) => {
  console.error("❌ Network/runtime error:", err);
  process.exit(3);
});
