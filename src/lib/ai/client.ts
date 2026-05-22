import Anthropic from "@anthropic-ai/sdk";
import { env, optionalEnv } from "@/lib/env";

/**
 * Singleton Anthropic client. We use two model tiers:
 *  - ORCHESTRATOR: Claude Opus 4.7 — agent orchestration, complex planning,
 *    re-optimization. High reasoning quality.
 *  - FAST: Claude Haiku 4.5 — destination scoring, single-shot card
 *    generation, classification, light enrichment. Low latency, low cost.
 */
let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  _client = new Anthropic({
    apiKey: apiKey || "missing-key",
    defaultHeaders: {
      "anthropic-version": "2023-06-01",
    },
    // Anthropic returns 529 ("overloaded") during traffic spikes. The SDK
    // retries 408/409/429/5xx with exponential backoff + jitter — bumping
    // from the default 2 to 5 absorbs brief overload windows without the
    // user seeing a dead chat.
    maxRetries: 5,
    timeout: 120_000,
  });
  return _client;
}

export const MODELS = {
  orchestrator: env("ANTHROPIC_MODEL_ORCHESTRATOR"),
  fast: env("ANTHROPIC_MODEL_FAST"),
} as const;

export type ModelTier = keyof typeof MODELS;

export function modelFor(tier: ModelTier) {
  return MODELS[tier];
}
