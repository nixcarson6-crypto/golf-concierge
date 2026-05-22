#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Sanity-check the Google Places (New) server key. Run with:
 *
 *   pnpm check:places
 *
 * Prints a clean PASS/FAIL with the exact reason Google returned —
 * no PowerShell quoting issues, no hidden error bodies.
 */

const key = process.env.GOOGLE_MAPS_SERVER_API_KEY;

if (!key) {
  console.error(
    "❌ GOOGLE_MAPS_SERVER_API_KEY is not set in .env.local",
  );
  process.exit(1);
}

console.log(
  `🔑 Using server key ending in …${key.slice(-6)} (length ${key.length})`,
);

const body = JSON.stringify({
  textQuery: "Pinehurst Resort",
  maxResultCount: 1,
});

async function main() {
  const res = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key!,
        "X-Goog-FieldMask": "places.displayName,places.photos",
      },
      body,
    },
  );

  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ Google rejected the request (HTTP ${res.status}):`);
    // Strip the key from any error echo before printing.
    console.error(text.replace(key!, "[REDACTED_KEY]"));
    console.error("");
    diagnose(res.status, text);
    process.exit(2);
  }

  type Resp = {
    places?: Array<{
      displayName?: { text?: string };
      photos?: Array<unknown>;
    }>;
  };
  const json = JSON.parse(text) as Resp;
  const first = json.places?.[0];
  if (!first) {
    console.warn(
      "⚠️  Key works, but no places came back. Probably an account/billing issue.",
    );
    process.exit(0);
  }

  const name = first.displayName?.text ?? "(unnamed)";
  const photoCount = first.photos?.length ?? 0;
  console.log(`✅ Key works. Google returned: "${name}" with ${photoCount} photo(s).`);
  if (photoCount === 0) {
    console.warn(
      "⚠️  Found the place but no photos attached — venue dependent.",
    );
  } else {
    console.log("🎉 You're good — photos should now render in the app.");
  }
}

function diagnose(status: number, body: string) {
  const b = body.toLowerCase();
  if (status === 403 && b.includes("api_key_service_blocked")) {
    console.error(
      "👉 FIX: Your server key works, but its 'API restrictions' list\n" +
        "   doesn't include Places API (New). Two-minute fix:\n" +
        "   1. Open https://console.cloud.google.com/apis/credentials\n" +
        "   2. Click the server key (the one in .env.local).\n" +
        "   3. Scroll to 'API restrictions'.\n" +
        "   4. Add 'Places API (New)' to the allowed list (there's\n" +
        "      usually 'Places API' AND 'Places API (New)' — pick the\n" +
        "      one with (New); that's what our code uses).\n" +
        "   5. Save. Wait ~30 seconds. Re-run pnpm check:places.",
    );
  } else if (status === 403 && b.includes("has not been used")) {
    console.error(
      "👉 FIX: 'Places API (New)' isn't enabled in your Google Cloud project.\n" +
        "   Open this URL, click Enable, wait ~30 seconds, retry:\n" +
        "   https://console.cloud.google.com/apis/library/places.googleapis.com",
    );
  } else if (status === 403 && b.includes("referer")) {
    console.error(
      "👉 FIX: Your server key has HTTP referrer restrictions (browser-only).\n" +
        "   Open Cloud Console → Credentials → click the server key →\n" +
        "   Application restrictions → set to 'None' → Save.\n" +
        "   https://console.cloud.google.com/apis/credentials",
    );
  } else if (b.includes("api key not valid") || b.includes("invalid_argument")) {
    console.error(
      "👉 FIX: The key value in .env.local looks wrong (typo, extra space,\n" +
        "   quoted incorrectly, or the wrong key entirely). Re-copy from\n" +
        "   Cloud Console.",
    );
  } else {
    console.error(
      "👉 Not a known pattern — paste the full error above to your dev pair.",
    );
  }
}

main().catch((err) => {
  console.error("❌ Network/runtime error:", err);
  process.exit(3);
});
