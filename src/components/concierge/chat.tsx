"use client";

import * as React from "react";
import { ArrowUp, Sparkles, Mic, MicOff } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, initials, relativeTime } from "@/lib/utils";
import { renderMarkdownBlock } from "@/lib/markdown";
import type { WorkspaceMessage, WorkspaceMe, WorkspaceTrip } from "./workspace";

const SUGGESTIONS = [
  "Plan a luxury golf trip for 8 guys in Scottsdale in October.",
  "Optimize for top courses and nightlife, $3,000 per person.",
  "We're flexible — recommend a destination for early November.",
];

export function ConciergeChat({
  trip,
  me,
  messages,
  onSend,
  sending,
  streamingReply,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  messages: WorkspaceMessage[];
  onSend: (text: string) => void;
  sending: boolean;
  streamingReply?: string | null;
}) {
  const [value, setValue] = React.useState("");
  const [listening, setListening] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const recogRef = React.useRef<{
    start: () => void;
    stop: () => void;
  } | null>(null);

  React.useEffect(() => {
    const el = scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    ) as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingReply]);

  const submit = () => {
    const text = value.trim();
    if (!text || sending) return;
    onSend(text);
    setValue("");
  };

  // Browser voice input — premium hands-free feel when supported.
  const toggleVoice = () => {
    if (typeof window === "undefined") return;
    const SR =
      (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recogRef.current?.stop();
      setListening(false);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recog: any = new (SR as any)();
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = "en-US";
    recog.onresult = (e: { results: { 0: { transcript: string } }[] }) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
      setValue(transcript);
    };
    recog.onend = () => setListening(false);
    recog.onerror = () => setListening(false);
    recog.start();
    recogRef.current = recog;
    setListening(true);
  };

  const voiceSupported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const showSuggestions = messages.length <= 1 && !trip.destination;

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-gradient-to-br from-[hsl(var(--gold))] to-[hsl(var(--gold-muted))] grid place-items-center text-[hsl(var(--primary-foreground))]">
          <Sparkles className="size-3.5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight">Concierge</p>
          <p className="text-[11px] text-muted-foreground truncate">
            Group thread for {trip.title}
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div
          className="px-5 py-6 space-y-5"
          aria-live="polite"
          aria-busy={sending}
        >
          {messages.map((m) => (
            <ChatMessageView key={m.id} message={m} meId={me.id} />
          ))}
          {streamingReply !== undefined &&
            streamingReply !== null &&
            streamingReply.length > 0 && (
              <ChatMessageView
                meId={me.id}
                message={{
                  id: "streaming",
                  role: "ASSISTANT",
                  content: streamingReply,
                  metadata: { streaming: true },
                  createdAt: new Date().toISOString(),
                  author: null,
                }}
              />
            )}
          {sending && (!streamingReply || streamingReply.length === 0) && (
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
            placeholder="Describe what you want — or just say a tweak…"
            className="bg-transparent border-0 focus-visible:ring-0 focus-visible:ring-offset-0 rounded-2xl min-h-[64px] max-h-[200px]"
            disabled={sending}
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <p className="text-[11px] text-muted-foreground">
              Enter to send · ⌘K for commands
            </p>
            <div className="flex items-center gap-2">
              {voiceSupported && (
                <Button
                  type="button"
                  variant={listening ? "destructive" : "ghost"}
                  size="icon"
                  onClick={toggleVoice}
                  className="size-9"
                >
                  {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                  <span className="sr-only">{listening ? "Stop voice" : "Voice input"}</span>
                </Button>
              )}
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
    </div>
  );
}

function ChatMessageView({
  message,
  meId,
}: {
  message: WorkspaceMessage;
  meId: string;
}) {
  const isAssistant = message.role === "ASSISTANT";
  const isMe = message.author?.id === meId;
  const followUps =
    (message.metadata?.followUps as string[] | undefined) ?? null;
  const kind = message.metadata?.kind as string | undefined;
  const authorName = isAssistant
    ? "Concierge"
    : message.author?.name ?? "Member";

  return (
    <div className={cn("flex gap-3", isMe && "flex-row-reverse")}>
      {isAssistant ? (
        <div className="size-7 rounded-lg shrink-0 grid place-items-center bg-gradient-to-br from-[hsl(var(--gold))] to-[hsl(var(--gold-muted))] text-[hsl(var(--primary-foreground))]">
          <Sparkles className="size-3.5" />
        </div>
      ) : (
        <Avatar className="size-7 rounded-lg">
          {message.author?.imageUrl && (
            <AvatarImage src={message.author.imageUrl} alt={authorName} />
          )}
          <AvatarFallback className="rounded-lg text-[10px]">
            {initials(authorName)}
          </AvatarFallback>
        </Avatar>
      )}
      <div
        className={cn(
          "min-w-0 max-w-[88%] space-y-1.5",
          isMe ? "items-end text-right" : "items-start",
        )}
      >
        {!isAssistant && !isMe && (
          <p className="text-[10px] text-muted-foreground">{authorName}</p>
        )}
        <div
          className={cn(
            "inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words",
            isMe
              ? "bg-surface-raised text-foreground border border-border"
              : isAssistant
                ? "bg-card/80 border border-border/70 text-foreground gold-border"
                : "bg-surface-sunken text-foreground border border-border/60",
          )}
        >
          {isAssistant ? (
            <div
              className="[&_ul]:my-1 [&_ol]:my-1"
              dangerouslySetInnerHTML={{
                __html: renderMarkdownBlock(message.content),
              }}
            />
          ) : (
            <span className="whitespace-pre-wrap">{message.content}</span>
          )}
          {kind === "itinerary" && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-[hsl(var(--gold))]">
              Itinerary drafted →
            </p>
          )}
          {kind === "item_update" && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-[hsl(var(--gold))]">
              Item updated →
            </p>
          )}
          {kind === "destination_options" && (
            <p className="mt-2 text-[11px] uppercase tracking-wide text-[hsl(var(--gold))]">
              Destinations proposed →
            </p>
          )}
        </div>
        {followUps && followUps.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", isMe && "justify-end")}>
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
            isMe ? "text-right" : "text-left",
          )}
        >
          {relativeTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
