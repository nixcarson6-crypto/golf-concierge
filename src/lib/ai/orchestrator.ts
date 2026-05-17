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
  const model = modelFor(opts.tier ?? "orchestrator");
  const toolName = opts.toolName ?? STRUCTURED_TOOL_DEFAULT;

  const jsonSchema = zodToJsonSchema(opts.schema);

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.5,
    system: opts.system,
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
    throw new Error(
      `[runStructured:${toolName}] model did not return a tool_use block`,
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
    temperature: opts.temperature ?? 0.6,
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

  const updateProgress = async (p: string) => {
    await db.agentRun.update({ where: { id: run.id }, data: { progress: p } });
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
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Tiny Zod → JSON-Schema converter                                            */
/* -------------------------------------------------------------------------- */

/**
 * Anthropic accepts a JSON Schema (draft-07-ish) for tool inputs. We do this
 * by hand for the subset we actually use — keeps us off another dependency.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap modifiers
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap());
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema.unwrap());
    const type = inner.type;
    if (Array.isArray(type)) return inner;
    if (typeof type === "string") {
      return { ...inner, type: [type, "null"] };
    }
    return inner;
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema.removeDefault());
    return { ...inner, default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodEffects) {
    return convert(schema.innerType());
  }

  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string" };
    const desc = schema.description;
    if (desc) out.description = desc;
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    if (schema._def.checks.some((c) => c.kind === "int")) out.type = "integer";
    for (const check of schema._def.checks) {
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    if (schema.description) out.description = schema.description;
    return out;
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options };
  }
  if (schema instanceof z.ZodNativeEnum) {
    return { type: "string", enum: Object.values(schema.enum as Record<string, string>) };
  }
  if (schema instanceof z.ZodArray) {
    const out: Record<string, unknown> = {
      type: "array",
      items: convert(schema.element),
    };
    if (schema._def.minLength) out.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) out.maxItems = schema._def.maxLength.value;
    if (schema.description) out.description = schema.description;
    return out;
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      // Treat as required unless explicitly optional or has a default
      const isOptional =
        value instanceof z.ZodOptional ||
        value instanceof z.ZodDefault ||
        (value instanceof z.ZodNullable && false); // nullable ≠ optional
      if (!isOptional) required.push(key);
    }
    const out: Record<string, unknown> = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    if (schema.description) out.description = schema.description;
    return out;
  }
  if (schema instanceof z.ZodRecord) {
    return { type: "object", additionalProperties: convert(schema.valueSchema) };
  }
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return {};
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((o: z.ZodTypeAny) => convert(o)) };
  }
  if (schema instanceof z.ZodLiteral) {
    const v = schema.value;
    return { type: typeof v, enum: [v] };
  }
  // Fallback: permissive
  return {};
}
