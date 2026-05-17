import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, modelFor } from "./client";

/**
 * Streaming reply helper. Yields text fragments as Claude generates them so
 * the chat UI can render token-by-token. The full text is also returned.
 *
 * We use streaming for the *reply text*, then run the structured constraint
 * extraction as a separate non-streamed call. Keeps each concern simple:
 * the streamed call has one job (write a great message); the structured
 * call has one job (update Trip state with typed fields).
 */
export type StreamReplyOptions = {
  system: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  cacheSystem?: boolean;
  maxTokens?: number;
  temperature?: number;
};

export async function* streamReplyTokens(
  opts: StreamReplyOptions,
): AsyncGenerator<string, string> {
  const client = anthropic();
  const systemParam = opts.cacheSystem
    ? [
        {
          type: "text" as const,
          text: opts.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : opts.system;

  const stream = client.messages.stream({
    model: modelFor("orchestrator"),
    max_tokens: opts.maxTokens ?? 800,
    system: systemParam,
    messages: opts.history.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  let full = "";
  for await (const event of stream as unknown as AsyncIterable<Anthropic.MessageStreamEvent>) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      full += event.delta.text;
      yield event.delta.text;
    }
  }
  return full;
}
