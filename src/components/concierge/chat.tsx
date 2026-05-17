"use client";

import * as React from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, relativeTime } from "@/lib/utils";
import type { WorkspaceMessage, WorkspaceTrip } from "./workspace";

const SUGGESTIONS = [
  "Plan a luxury golf trip for 8 guys in Scottsdale in October.",
  "Optimize for top courses and nightlife, $3,000 per person.",
  "We're flexible — recommend a destination for early November.",
];

export function ConciergeChat({
  trip,
  messages,
  onSend,
  sending,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  messages: WorkspaceMessage[];
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const [value, setValue] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const text = value.trim();
    if (!text || sending) return;
    onSend(text);
    setValue("");
  };

  const showSuggestions = messages.length <= 1 && !trip.destination;

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-gradient-to-br from-[hsl(var(--gold))] to-[hsl(var(--gold-muted))] grid place-items-center text-[hsl(var(--primary-foreground))]">
          <Sparkles className="size-3.5" />
        </div>
        <div>
          <p className="text-sm font-medium leading-tight">Concierge</p>
          <p className="text-[11px] text-muted-foreground">
            Briefing for {trip.title}
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="px-5 py-6 space-y-5">
          {messages.map((m) => (
            <ChatMessageView key={m.id} message={m} />
          ))}
          {sending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-9">
              <span className="size-1.5 rounded-full bg-[hsl(var(--gold))] animate-pulse-soft" />
              <span className="size-1.5 rounded-full bg-[hsl(var(--gold))] animate-pulse-soft [animation-delay:120ms]" />
              <span className="size-1.5 rounded-full bg-[hsl(var(--gold))] animate-pulse-soft [animation-delay:240ms]" />
            </div>
          )}
          {showSuggestions && (
            <div className="pt-2 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onSend(s)}
                  disabled={sending}
                  className="text-left text-xs px-3 py-2 rounded-xl border border-border/70 bg-surface-raised/50 hover:bg-surface-raised hover:border-foreground/20 transition disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border/60 bg-surface/40">
        <div className="rounded-2xl border border-border bg-surface-raised/70 focus-within:border-foreground/30 transition">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Describe what you want — group, dates, vibe, budget…"
            className="bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 rounded-2xl min-h-[64px] max-h-[200px]"
            disabled={sending}
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <p className="text-[11px] text-muted-foreground">
              Enter to send · Shift+Enter for new line
            </p>
            <Button
              variant="gold"
              size="sm"
              onClick={submit}
              disabled={!value.trim() || sending}
            >
              <ArrowUp className="size-4" />
              <span className="sr-only">Send</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMessageView({ message }: { message: WorkspaceMessage }) {
  const isUser = message.role === "USER";
  const followUps =
    (message.metadata?.followUps as string[] | undefined) ?? null;
  const kind = message.metadata?.kind as string | undefined;

  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "size-7 rounded-lg shrink-0 grid place-items-center text-[11px] font-medium",
          isUser
            ? "bg-surface-raised border border-border text-muted-foreground"
            : "bg-gradient-to-br from-[hsl(var(--gold))] to-[hsl(var(--gold-muted))] text-[hsl(var(--primary-foreground))]",
        )}
      >
        {isUser ? "You" : <Sparkles className="size-3.5" />}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-[88%] space-y-1.5",
          isUser ? "items-end text-right" : "items-start",
        )}
      >
        <div
          className={cn(
            "inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
            isUser
              ? "bg-surface-raised text-foreground border border-border"
              : "bg-card/80 border border-border/70 text-foreground gold-border",
          )}
        >
          {message.content}
          {kind === "itinerary" && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-[hsl(var(--gold))]">
              Itinerary drafted →
            </p>
          )}
          {kind === "destination_options" && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-[hsl(var(--gold))]">
              Destinations proposed →
            </p>
          )}
        </div>
        {followUps && followUps.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", isUser && "justify-end")}>
            {followUps.map((q, i) => (
              <span
                key={i}
                className="text-[11px] px-2 py-1 rounded-full border border-border/70 bg-surface-raised/50 text-muted-foreground"
              >
                {q}
              </span>
            ))}
          </div>
        )}
        <p
          className={cn(
            "text-[10px] text-muted-foreground/60",
            isUser ? "text-right" : "text-left",
          )}
        >
          {relativeTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
