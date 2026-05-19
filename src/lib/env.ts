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
    default: "claude-opus-4-7",
  },
  ANTHROPIC_MODEL_FAST: {
    required: false,
    default: "claude-haiku-4-5-20251001",
  },

  STRIPE_SECRET_KEY: { required: false },
  STRIPE_WEBHOOK_SECRET: { required: false },
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: { required: false },

  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: { required: false },
  GOOGLE_MAPS_SERVER_API_KEY: { required: false },

  RESEND_API_KEY: { required: false },
  RESEND_FROM_EMAIL: {
    required: false,
    default: "Golf Concierge <concierge@example.com>",
  },

  INNGEST_EVENT_KEY: { required: false },
  INNGEST_SIGNING_KEY: { required: false },

  GOLFNOW_API_KEY: { required: false },
  EXPEDIA_RAPID_API_KEY: { required: false },
  DUFFEL_API_KEY: { required: false },
  HOTELBEDS_API_KEY: { required: false },
  HOTELBEDS_SECRET: { required: false },
  OPENTABLE_API_KEY: { required: false },
  UBER_FOR_BUSINESS_TOKEN: { required: false },
  HERTZ_API_KEY: { required: false },

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
