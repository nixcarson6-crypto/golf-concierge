"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUp,
  Sparkles,
  Mic,
  MicOff,
  Check,
  CreditCard,
  ChevronRight,
  Mail,
  Loader2,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, formatCurrency, initials, relativeTime } from "@/lib/utils";
import { renderMarkdownBlock } from "@/lib/markdown";
import type {
  WorkspaceMessage,
  WorkspaceMe,
  WorkspaceTrip,
  WorkspaceDestinationOption,
} from "./workspace";

const SUGGESTIONS_FRESH = [
  "Plan a luxury golf trip for 8 in Scottsdale in October.",
  "Optimize for top courses and nightlife, $3,000 per person.",
  "We're flexible — recommend a destination for early November.",
];
const SUGGESTIONS_PLANNING = [
  "Swap the steakhouse for sushi.",
  "Add a spa morning on day 2.",
  "Find a cheaper hotel without losing the location.",
];
const SUGGESTIONS_APPROVED = [
  "What's still outstanding?",
  "Move the Wednesday tee time earlier.",
  "Add a dinner reservation for arrival night.",
];

function pickSuggestions(args: {
  hasDestination: boolean;
  hasItinerary: boolean;
  isApproved: boolean;
}): string[] {
  if (args.isApproved) return SUGGESTIONS_APPROVED;
  if (args.hasItinerary || args.hasDestination) return SUGGESTIONS_PLANNING;
  return SUGGESTIONS_FRESH;
}

export function ConciergeChat({
  tripId,
  trip,
  me,
  messages,
  destinations,
  approval,
  currentItineraryId,
  onSend,
  sending,
  streamingReply,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  messages: WorkspaceMessage[];
  destinations: WorkspaceDestinationOption[];
  approval: { approved: number; total: number; quorum: number };
  currentItineraryId: string | null;
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

  const lastUserMsgIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "USER") return i;
    }
    return -1;
  })();
  const turnsSinceLastUser = messages.length - 1 - lastUserMsgIndex;
  const tripIsBooked = trip.status === "BOOKED" || trip.status === "COMPLETED";
  const suggestions = pickSuggestions({
    hasDestination: Boolean(trip.destination),
    hasItinerary: trip.status === "PLANNING" || trip.status === "AWAITING_APPROVAL",
    isApproved: trip.status === "APPROVED" || trip.status === "BOOKING",
  });
  const showSuggestions =
    !tripIsBooked && (turnsSinceLastUser >= 1 || messages.length <= 1);

  const latestAssistantId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "ASSISTANT") return messages[i].id;
    }
    return null;
  }, [messages]);

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <div className="px-5 py-4 border-b border-border/60 flex items-center gap-2.5">
        <div className="size-7 rounded-lg bg-[hsl(var(--navy))] grid place-items-center text-[hsl(var(--primary-foreground))]">
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
            <ChatMessageView
              key={m.id}
              message={m}
              meId={me.id}
              isLatestAssistant={m.id === latestAssistantId}
              tripId={tripId}
              trip={trip}
              me={me}
              destinations={destinations}
              approval={approval}
              currentItineraryId={currentItineraryId}
            />
          ))}
          {streamingReply !== undefined &&
            streamingReply !== null &&
            streamingReply.length > 0 && (
              <ChatMessageView
                meId={me.id}
                tripId={tripId}
                trip={trip}
                me={me}
                destinations={destinations}
                approval={approval}
                currentItineraryId={currentItineraryId}
                isLatestAssistant={false}
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
              <span className="size-1.5 rounded-full bg-[hsl(var(--copper))] animate-pulse-soft" />
              <span className="size-1.5 rounded-full bg-[hsl(var(--copper))] animate-pulse-soft [animation-delay:120ms]" />
              <span className="size-1.5 rounded-full bg-[hsl(var(--copper))] animate-pulse-soft [animation-delay:240ms]" />
            </div>
          )}
          {showSuggestions && suggestions.length > 0 && (
            <div className="pt-2 flex flex-wrap gap-2">
              {suggestions.map((s) => (
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
            <p className="text-[11px] text-muted-foreground">Enter to send</p>
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
                variant="navy"
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
  isLatestAssistant,
  tripId,
  trip,
  me,
  destinations,
  approval,
  currentItineraryId,
}: {
  message: WorkspaceMessage;
  meId: string;
  isLatestAssistant: boolean;
  tripId: string;
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  destinations: WorkspaceDestinationOption[];
  approval: { approved: number; total: number; quorum: number };
  currentItineraryId: string | null;
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
        <div className="size-7 rounded-lg shrink-0 grid place-items-center bg-[hsl(var(--navy))] text-[hsl(var(--primary-foreground))]">
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
            "inline-block rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words text-left",
            isMe
              ? "bg-surface-raised text-foreground border border-border"
              : isAssistant
                ? "bg-card/80 border border-border/70 text-foreground navy-border"
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
        </div>

        {isAssistant && (
          <InlineActions
            kind={kind}
            isLatestAssistant={isLatestAssistant}
            tripId={tripId}
            trip={trip}
            me={me}
            destinations={destinations}
            approval={approval}
            currentItineraryId={currentItineraryId}
            messageItineraryId={
              (message.metadata?.itineraryId as string | undefined) ?? null
            }
          />
        )}

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

function InlineActions({
  kind,
  isLatestAssistant,
  tripId,
  trip,
  me,
  destinations,
  approval,
  currentItineraryId,
  messageItineraryId,
}: {
  kind: string | undefined;
  isLatestAssistant: boolean;
  tripId: string;
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  destinations: WorkspaceDestinationOption[];
  approval: { approved: number; total: number; quorum: number };
  currentItineraryId: string | null;
  messageItineraryId: string | null;
}) {
  if (kind === "destination_options" && !trip.destination) {
    return <DestinationActions tripId={tripId} destinations={destinations} />;
  }

  if (!isLatestAssistant) return null;

  const itineraryId = messageItineraryId ?? currentItineraryId;

  if (
    kind === "itinerary" &&
    itineraryId &&
    trip.status !== "APPROVED" &&
    trip.status !== "BOOKING" &&
    trip.status !== "BOOKED"
  ) {
    return (
      <ApprovalAction
        tripId={tripId}
        itineraryId={itineraryId}
        me={me}
        approval={approval}
      />
    );
  }

  if (
    (trip.status === "APPROVED" || trip.status === "BOOKING") &&
    me.myPayment !== "PAID"
  ) {
    return <PayAction tripId={tripId} />;
  }

  return null;
}

function DestinationActions({
  tripId,
  destinations,
}: {
  tripId: string;
  destinations: WorkspaceDestinationOption[];
}) {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  if (destinations.length === 0) return null;

  const choose = async (id: string) => {
    setPendingId(id);
    try {
      const res = await fetch(
        `/api/trips/${tripId}/destinations/${id}/select`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await res.text());
      toast.success("Destination locked in. Building the itinerary…");
      qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Couldn't select that destination.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {destinations.map((d) => (
        <button
          key={d.id}
          type="button"
          onClick={() => choose(d.id)}
          disabled={pendingId !== null}
          className="group flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised/60 px-3.5 py-2.5 text-left text-sm hover:border-[hsl(var(--navy)/0.5)] hover:bg-surface-raised transition disabled:opacity-50"
        >
          <span className="min-w-0 truncate font-medium">{d.name}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            {d.estimatedPerPersonCost
              ? `${formatCurrency(d.estimatedPerPersonCost / 100)}/pax`
              : null}
            {pendingId === d.id ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ChevronRight className="size-3.5 transition group-hover:translate-x-0.5" />
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function ApprovalAction({
  tripId,
  itineraryId,
  me,
  approval,
}: {
  tripId: string;
  itineraryId: string;
  me: WorkspaceMe;
  approval: { approved: number; total: number; quorum: number };
}) {
  const qc = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);

  if (me.myApproval === "APPROVED") {
    return (
      <p className="text-[11px] text-muted-foreground pt-1">
        <Check className="inline size-3 mr-1 text-[hsl(var(--emerald))]" />
        You approved — waiting on {approval.total - approval.approved} more.
      </p>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "APPROVED", itineraryId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Approved.");
      qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Couldn't record approval.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pt-1">
      <Button variant="navy" size="sm" onClick={submit} disabled={submitting}>
        {submitting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        Approve trip
      </Button>
    </div>
  );
}

function PayAction({ tripId }: { tripId: string }) {
  const [submitting, setSubmitting] = React.useState(false);

  const pay = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/payments/payment-link`, {
        method: "POST",
      });
      const json = (await res.json()) as { url?: string };
      if (!res.ok || !json.url) throw new Error("no link");
      window.location.href = json.url;
    } catch {
      toast.error("Couldn't open the payment page.");
      setSubmitting(false);
    }
  };

  return (
    <div className="pt-1">
      <Button variant="copper" size="sm" onClick={pay} disabled={submitting}>
        {submitting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <CreditCard className="size-3.5" />
        )}
        Pay my share
      </Button>
    </div>
  );
}

export function InlineInviteForm({ tripId }: { tripId: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async () => {
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Invite sent to ${email}.`);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Couldn't send invite.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex items-center gap-2 pt-1">
      <Input
        type="email"
        placeholder="friend@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="h-8 text-sm"
      />
      <Button variant="navy" size="sm" onClick={submit} disabled={submitting}>
        {submitting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Mail className="size-3.5" />
        )}
        Invite
      </Button>
    </div>
  );
}
