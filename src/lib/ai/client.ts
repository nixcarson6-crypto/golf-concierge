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
    // retries 408/409/429/5xx with exponential backoff + jitter. FAIL FAST
    // (Carson's call): 5 retries × a 120s timeout could hang a build for ~10
    // minutes when Opus is overloaded — the customer just watches a spinner.
    // 2 retries × 75s caps the worst case near ~2.5 min, then a clean error
    // ("try again / simpler request") instead of an endless hang. 75s still
    // comfortably covers a legit itinerary generation (multi-leg trips fan
    // out per leg, so each call is bounded).
    maxRetries: 2,
    timeout: 75_000,
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
