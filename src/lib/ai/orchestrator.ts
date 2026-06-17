/**
 * Hand-rolled multi-agent orchestrator.
 *
 * Why not LangGraph: every agent here is a single Claude call (occasionally a
 * tool-using one). A typed `runAgent` + `runStructured` helper around the
 * Anthropic SDK gets us 95% of the value with a fraction of the surface area
 * and zero hidden state — and remains trivially portable if we ever want to
 * switch frameworks.
 */

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, modelFor, type ModelTier } from "./client";
import { db } from "@/lib/db";
import type { AgentType } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { emitTripEvent, nudge } from "@/lib/events";

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

export type RunStructuredOptions<T extends z.ZodTypeAny> = {
  tier?: ModelTier;
  system: string;
  messages: AgentMessage[];
  schema: T;
  /** What this structured-output tool is called. Surfaces in errors. */
  toolName?: string;
  toolDescription?: string;
  maxTokens?: number;
  /** Optional reasoning/effort budget (forwarded to Anthropic where supported). */
  thinking?: { enabled: boolean; budgetTokens?: number };
  temperature?: number;
  /** Explicit model id override. Wins over `tier`. Used for graceful
   *  degradation — e.g. fall back to Sonnet when Opus is overloaded. */
  model?: string;
  /** When true, mark the system prompt as cacheable. Reduces cost + latency
   * for prompts that are stable across many turns (most of ours). */
  cacheSystem?: boolean;
};

const STRUCTURED_TOOL_DEFAULT = "emit_result";

/**
 * Runs Claude with a forced tool call so the model is required to produce a
 * structured payload validated against the provided Zod schema.
 *
 * This is more reliable than prose-then-JSON parsing and gives us a
 * single source of truth (the schema) for what the agent can return.
 */
export async function runStructured<T extends z.ZodTypeAny>(
  opts: RunStructuredOptions<T>,
): Promise<z.infer<T>> {
  const client = anthropic();
  const model = opts.model ?? modelFor(opts.tier ?? "orchestrator");
  const toolName = opts.toolName ?? STRUCTURED_TOOL_DEFAULT;

  const jsonSchema = zodToJsonSchema(opts.schema);

  const systemParam = opts.cacheSystem
    ? [
        {
          type: "text" as const,
          text: opts.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : opts.system;

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    system: systemParam,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: [
      {
        name: toolName,
        description:
          opts.toolDescription ??
          "Emit the structured result. You MUST call this tool exactly once.",
        input_schema: jsonSchema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: toolName },
    ...(opts.thinking?.enabled
      ? {
          thinking: {
            type: "enabled" as const,
            budget_tokens: opts.thinking.budgetTokens ?? 4000,
          },
        }
      : {}),
  });

  const toolUse = response.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use",
  );
  if (!toolUse) {
    // Surface the real reason when the model never got to the tool
    // call — usually `max_tokens` on a too-large itinerary or `refusal`
    // on a constraint conflict. Cryptic "did not return a tool_use"
    // errors were sending customers in circles.
    throw new Error(
      `[runStructured:${toolName}] model did not return a tool_use block (stop_reason=${response.stop_reason})`,
    );
  }

  // Truncation: the model started the tool call but ran out of tokens
  // mid-JSON. Anthropic returns whatever it managed to emit, but
  // required fields are usually missing → schema validation fails
  // with a useless "Required" error. Catch this case explicitly so the
  // caller can retry with a bigger budget or split the work.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `[runStructured:${toolName}] response truncated at max_tokens — payload too large for the budget. Retry with a higher maxTokens or simplify the request.`,
    );
  }

  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      `[runStructured:${toolName}] schema validation failed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Free-form text generation                                                  */
/* -------------------------------------------------------------------------- */

export type RunTextOptions = {
  tier?: ModelTier;
  system: string;
  messages: AgentMessage[];
  maxTokens?: number;
  temperature?: number;
};

export async function runText(opts: RunTextOptions): Promise<string> {
  const client = anthropic();
  const model = modelFor(opts.tier ?? "fast");
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });
  return response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Persisted agent runs                                                       */
/* -------------------------------------------------------------------------- */

export type RecordedAgent<TOutput> = {
  runId: string;
  output: TOutput;
};

export async function withAgentRun<TOutput>(args: {
  tripId: string;
  agentType: AgentType;
  input?: unknown;
  progress?: string;
  fn: (ctx: { runId: string; updateProgress: (p: string) => Promise<void> }) => Promise<TOutput>;
}): Promise<RecordedAgent<TOutput>> {
  const run = await db.agentRun.create({
    data: {
      tripId: args.tripId,
      agentType: args.agentType,
      status: "RUNNING",
      input: args.input == null ? Prisma.DbNull : (args.input as Prisma.InputJsonValue),
      progress: args.progress,
      startedAt: new Date(),
    },
  });

  nudge(args.tripId);

  const updateProgress = async (p: string) => {
    await db.agentRun.update({ where: { id: run.id }, data: { progress: p } });
    emitTripEvent({
      kind: "agent.progress",
      tripId: args.tripId,
      runId: run.id,
      progress: p,
    });
  };

  try {
    const output = await args.fn({ runId: run.id, updateProgress });
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output: output == null ? Prisma.DbNull : (output as Prisma.InputJsonValue),
        completedAt: new Date(),
      },
    });
    nudge(args.tripId);
    return { runId: run.id, output };
  } catch (err) {
    await db.agentRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    });
    nudge(args.tripId);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Zod → JSON-Schema (zod v4 native)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Anthropic accepts a JSON Schema for tool inputs. zod v4 ships a native
 * converter (`z.toJSONSchema`) that produces exactly the shape we need —
 * type/properties/required/additionalProperties:false — so we no longer
 * hand-roll it. `io: "input"` describes the data the model must PRODUCE
 * (pre-parse), which is the correct side for a tool's input_schema.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "input",
    // Don't fail the whole conversion on an exotic node — emit a
    // permissive {} for anything zod can't represent (matches the old
    // hand-rolled fallback behaviour).
    unrepresentable: "any",
  }) as Record<string, unknown>;
  // Drop the top-level "$schema" meta key — Anthropic's tool input_schema
  // wants the bare schema object, and the old hand-rolled converter never
  // emitted it.
  delete json.$schema;
  return json;
}
