/**
 * Centralised env access. Throws loudly in production when a required value
 * is missing so the failure surfaces at boot, not deep in a request handler.
 */

type EnvDef = {
  required?: boolean;
  default?: string;
  /** Whether to enforce the required check in non-production environments too. */
  strict?: boolean;
};

const definitions = {
  DATABASE_URL: { required: true, strict: true },
  DIRECT_URL: { required: false },

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { required: true },
  CLERK_SECRET_KEY: { required: true },
  CLERK_WEBHOOK_SECRET: { required: false },

  ANTHROPIC_API_KEY: { required: true },
  ANTHROPIC_MODEL_ORCHESTRATOR: {
    required: false,
    default: "claude-opus-4-8",
  },
  ANTHROPIC_MODEL_FAST: {
    required: false,
    default: "claude-haiku-4-5-20251001",
  },

  TAVILY_API_KEY: { required: false },

  STRIPE_SECRET_KEY: { required: false },
  STRIPE_WEBHOOK_SECRET: { required: false },
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: { required: false },

  // LiteAPI — primary hotel booking API (search + book ~2M properties). The
  // browser agent is the fallback for properties it doesn't cover.
  LITEAPI_KEY: { required: false },

  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: { required: false },
  GOOGLE_MAPS_SERVER_API_KEY: { required: false },

  RESEND_API_KEY: { required: false },
  RESEND_FROM_EMAIL: {
    required: false,
    // Resend's shared test sender works with just an API key (no domain
    // verification) but only delivers to the account owner's own address —
    // perfect for `pnpm check:email`. Swap to "Pyltrix <hello@pyltrix.com>"
    // once the pyltrix.com domain is verified in the Resend dashboard.
    default: "Pyltrix <onboarding@resend.dev>",
  },

  INNGEST_EVENT_KEY: { required: false },
  INNGEST_SIGNING_KEY: { required: false },

  GOLFNOW_API_KEY: { required: false },
  EXPEDIA_RAPID_API_KEY: { required: false },
  DUFFEL_API_KEY: { required: false },
  HOTELBEDS_API_KEY: { required: false },
  HOTELBEDS_SECRET: { required: false },
  // "test" (default — api.test.hotelbeds.com) or "production".
  HOTELBEDS_ENV: { required: false, default: "test" },
  OPENTABLE_API_KEY: { required: false },
  UBER_FOR_BUSINESS_TOKEN: { required: false },
  // Uber Guest Rides API (developer.uber.com). Sandbox works the moment
  // the app is created; production needs the U4B Central API grant.
  UBER_CLIENT_ID: { required: false },
  UBER_CLIENT_SECRET: { required: false },
  // "sandbox" (default) or "production". Same code paths; we just point
  // at sandbox-api.uber.com vs api.uber.com depending on this flag.
  UBER_ENV: { required: false, default: "sandbox" },
  // Uber for Business organization UUID. Required for actual ride
  // creation in production; sandbox tolerates a placeholder.
  UBER_ORG_UUID: { required: false },
  HERTZ_API_KEY: { required: false },
  AVIS_API_KEY: { required: false },
  LIGHTSPEED_GOLF_API_KEY: { required: false },
  YELP_FUSION_API_KEY: { required: false },
  YELP_FUSION_CLIENT_ID: { required: false },

  // Browser-agent booking infra. Browserbase = headless browser the agent
  // drives over CDP. Configured ⇒ the agent dryrun script + (later) the
  // BookingPartner `browser-agent` provider can actually run; unset ⇒
  // both gracefully no-op so the rest of the app keeps working as today.
  BROWSERBASE_API_KEY: { required: false },
  BROWSERBASE_PROJECT_ID: { required: false },
  BROWSERBASE_REGION: { required: false, default: "us-east-1" },
  // Which browser infra the agent runs on: "steel" (steel.dev — the
  // DEFAULT; Carson's call June 2026 after head-to-head testing: faster
  // session startup, equal reliability) or "browserbase" (kept as the
  // one-word fallback; keys stay in .env.local).
  BROWSER_PROVIDER: { required: false, default: "steel" },
  // Steel.dev API key — only used when BROWSER_PROVIDER=steel.
  STEEL_API_KEY: { required: false },
  // "true" to enable paid Browserbase features (advancedStealth + proxies +
  // captcha solving). Default off so the agent runs on the free tier.
  BROWSERBASE_PREMIUM: { required: false },
  BROWSERBASE_SOLVE_CAPTCHAS: { required: false },
  BROWSERBASE_ADVANCED_STEALTH: { required: false },
  BROWSER_AGENT_MAX_ATTEMPTS: { required: false },
  // Booking engine: "stagehand" (DOM-driven, fast — default) or
  // "computer-use" (legacy vision loop, fallback).
  BOOKING_ENGINE: { required: false },
  STAGEHAND_MODEL: { required: false },
  STAGEHAND_EXECUTION_MODEL: { required: false },
  STAGEHAND_MAX_STEPS: { required: false },
  // Per-action timeout (ms) for one agent tool call. Default 25s; caps
  // hung selectors on heavy sites so they don't burn the wall-clock budget.
  STAGEHAND_TOOL_TIMEOUT_MS: { required: false },
  // "false" disables the CDP heavy-resource blocklist (analytics/ads/video
  // the DOM agent never needs). Default on — it speeds every page load.
  BROWSER_AGENT_BLOCK_HEAVY: { required: false },
  // Hard per-attempt wall-clock for a browser-agent booking (ms). Default
  // 180000 (3 min) — a venue that can't book in 3 min falls back cleanly.
  BROWSER_AGENT_TIMEOUT_MS: { required: false },
  // Images are blocked during the agent run by DEFAULT (biggest page-load
  // win). Set "false" to restore a pristine confirmation screenshot at the
  // cost of speed.
  BROWSER_AGENT_BLOCK_IMAGES: { required: false },
  // Model used by the booking agent's computer-use loop. MUST be a model
  // that supports the computer_20250124 tool — that's a Sonnet-line
  // capability; Opus 4.x doesn't carry it. Sonnet 4.5 is the stable default.
  ANTHROPIC_MODEL_COMPUTER_USE: {
    required: false,
    default: "claude-sonnet-4-5",
  },
  // Shared secret guarding the internal nudge bridge: the Inngest worker
  // (which runs separately from the web process) posts to this route to
  // push live agent progress over the SSE pipe. Set in .env.local; any
  // string the worker + web both see. If unset, live progress falls back
  // to client-side polling.
  INTERNAL_NUDGE_SECRET: { required: false },
  // How many destination legs to plan in parallel on a multi-leg trip.
  // Default 2 — keeps low-tier Anthropic accounts under the rate limit so
  // parallel calls don't trigger a backoff storm. Bump on a higher API tier.
  MULTI_LEG_CONCURRENCY: { required: false },

  NEXT_PUBLIC_APP_URL: {
    required: false,
    default: "http://localhost:3000",
  },
} satisfies Record<string, EnvDef>;

type Keys = keyof typeof definitions;

function read(key: Keys): string | undefined {
  const def = definitions[key] as EnvDef;
  const v = process.env[key as string];
  if (v != null && v !== "") return v;
  if (def.default) return def.default;
  return undefined;
}

export function env(key: Keys): string {
  const def = definitions[key] as EnvDef;
  const v = read(key);
  if (v == null) {
    const enforce =
      def.required && (process.env.NODE_ENV === "production" || def.strict);
    if (enforce) {
      throw new Error(`Missing required env var: ${String(key)}`);
    }
    return "";
  }
  return v;
}

export function optionalEnv(key: Keys): string | undefined {
  return read(key);
}

export function envBool(key: Keys, fallback = false): boolean {
  const v = read(key);
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const isProd = process.env.NODE_ENV === "production";
export const isDev = process.env.NODE_ENV !== "production";
