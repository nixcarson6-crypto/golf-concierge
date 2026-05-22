"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConciergeChat } from "./chat";
import { LivePreview } from "./live-preview";
import { PushPrompt } from "./push-prompt";
import { Button } from "@/components/ui/button";
import { Eye, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import type { ChatCard } from "@/lib/ai/chat-cards";
import type {
  ItineraryItemType,
  ConfirmationState,
  AgentType,
  AgentStatus,
  ChatRole,
  TripStatus,
  TripRole,
  ApprovalStatus,
  PaymentStatus,
  NotificationType,
} from "@prisma/client";

export type SuggestedFlightOffer = {
  id: string;
  totalAmount: number;
  currency: string;
  perPassengerAmount: number;
  airlineName: string;
  airlineIataCode: string;
  slices: Array<{
    origin: string;
    destination: string;
    departing: string;
    arriving: string;
    durationMinutes: number;
    stops: number;
    cabin: string;
    segments?: Array<{
      flightNumber: string;
      origin: string;
      destination: string;
      departing: string;
      arriving: string;
    }>;
  }>;
  expiresAt: string | null;
};

export type WorkspaceTrip = {
  id: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  groupSize: number | null;
  budgetTotal: number | null;
  budgetPerPerson: number | null;
  status: TripStatus;
  suggestedFlights: {
    fetchedAt: string;
    origin: string;
    destination: string;
    cabin: string;
    passengers: number;
    offers: SuggestedFlightOffer[];
  } | null;
};

export type WorkspaceMe = {
  id: string;
  name: string | null;
  email: string;
  imageUrl: string | null;
  role: TripRole;
  myApproval: ApprovalStatus | null;
  myPayment: PaymentStatus | null;
  profile: {
    legalGivenName: string | null;
    legalFamilyName: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    phone: string | null;
  };
};

export type WorkspaceMember = {
  id: string;
  userId: string | null;
  name: string | null;
  email: string;
  imageUrl: string | null;
  role: TripRole;
  approvalStatus: ApprovalStatus;
  paymentStatus: PaymentStatus;
};

export type WorkspaceMessage = {
  id: string;
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  author: { id: string; name: string | null; imageUrl: string | null } | null;
};

export type WorkspaceItineraryItem = {
  id: string;
  type: ItineraryItemType;
  title: string;
  description: string | null;
  location: string | null;
  startTime: string | null;
  endTime: string | null;
  cost: number | null;
  status: string | null;
  confirmationState: ConfirmationState;
  aiRationale: string | null;
  locked: boolean;
};

export type WorkspaceItinerary = {
  id: string;
  status: "DRAFT" | "CURRENT" | "APPROVED" | "SUPERSEDED";
  version: number;
  aiSummary: string | null;
  totalCost: number | null;
  perPersonCost: number | null;
  changes: string[];
  items: WorkspaceItineraryItem[];
};

export type WorkspaceAgentRun = {
  id: string;
  agentType: AgentType;
  status: AgentStatus;
  progress: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type WorkspaceNotification = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

export type WorkspaceDestinationOption = {
  id: string;
  name: string;
  description: string | null;
  estimatedPerPersonCost: number | null;
};

export type WorkspaceBookedSlice = {
  origin: string;
  destination: string;
  originName: string | null;
  destinationName: string | null;
  departing: string;
  arriving: string;
  flightNumber: string | null;
  marketingCarrier: string | null;
  cabinClass: string | null;
  stops: number;
};

export type WorkspaceBooking = {
  id: string;
  type: ItineraryItemType;
  title: string;
  provider: string;
  confirmationCode: string | null;
  cost: number | null;
  status: string;
  isStub: boolean;
  paidAt: string | null;
  // Optional rich details surfaced for the expandable booking view in
  // the Live Trip panel. Set when present on the partner payload.
  vendor: string | null;
  summary: string | null;
  partyNames: string[] | null;
  contactEmail: string | null;
  leadLastName: string | null;
  airlineCode: string | null;
  bookedSlices: WorkspaceBookedSlice[] | null;
  isSandbox: boolean;
  confirmedAt: string | null;
  providerReference: string | null;
};

type Props = { tripId: string; vapidPublicKey?: string | null };

function WorkspaceSkeleton() {
  return (
    <div className="container py-5">
      <div className="hidden lg:grid grid-cols-12 gap-5 h-[calc(100dvh-7rem)]">
        <div className="col-span-7 rounded-3xl glass shimmer" />
        <div className="col-span-5 rounded-3xl glass shimmer" />
      </div>
      <div className="lg:hidden h-[calc(100dvh-10rem)] rounded-3xl glass shimmer" />
    </div>
  );
}

type WorkspaceSnapshot = {
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  messages: WorkspaceMessage[];
  itinerary: WorkspaceItinerary | null;
  agentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  destinations: WorkspaceDestinationOption[];
  members: WorkspaceMember[];
  approval: { approved: number; total: number; quorum: number };
  notifications: WorkspaceNotification[];
  bookings?: WorkspaceBooking[];
};

export function ConciergeWorkspace({ tripId, vapidPublicKey }: Props) {
  const qc = useQueryClient();
  const seenNotifications = React.useRef<Set<string>>(new Set());
  const [mobileView, setMobileView] = React.useState<"chat" | "preview">("chat");
  // Suppress SSE-driven refetches while we're streaming a reply. The server
  // fires `nudge` (which becomes a `snapshot.changed` SSE event) right after
  // persisting the user message AND right after persisting the assistant
  // reply — both happen during the same response stream. Without this guard,
  // the refetch races with our optimistic streaming bubble and blows it
  // away mid-token, which is the flicker users see.
  const isStreamingRef = React.useRef(false);

  const { data } = useQuery<WorkspaceSnapshot>({
    queryKey: ["workspace", tripId],
    queryFn: async () => {
      const res = await fetch(`/api/trips/${tripId}/workspace`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load workspace");
      return res.json();
    },
  });

  // Context-aware chat suggestions. Re-fetched whenever the workspace
  // snapshot changes (destination updates, bookings happen, etc.) so the
  // suggestions stay aligned with the actual trip state.
  const snapshotKey = data
    ? `${data.trip.destination ?? ""}|${data.trip.startDate ?? ""}|${data.trip.groupSize ?? ""}|${data.bookings?.length ?? 0}|${data.messages.length}`
    : null;
  const { data: suggestionsData } = useQuery<{ suggestions: string[] }>({
    queryKey: ["suggestions", tripId, snapshotKey],
    queryFn: async () => {
      const res = await fetch(`/api/trips/${tripId}/suggestions`, {
        cache: "no-store",
      });
      if (!res.ok) return { suggestions: [] };
      return res.json();
    },
    enabled: Boolean(data),
    staleTime: 30_000,
  });

  React.useEffect(() => {
    const es = new EventSource(`/api/trips/${tripId}/stream`);
    const refetch = () => {
      if (isStreamingRef.current) return;
      qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    };
    es.addEventListener("snapshot.changed", refetch);
    es.addEventListener("agent.progress", refetch);
    es.addEventListener("notification", refetch);
    es.addEventListener("ready", refetch);
    es.onerror = () => {};
    return () => es.close();
  }, [tripId, qc]);

  React.useEffect(() => {
    if (!data) return;
    const initialLoad = seenNotifications.current.size === 0;
    for (const n of data.notifications) {
      if (seenNotifications.current.has(n.id)) continue;
      seenNotifications.current.add(n.id);
      if (initialLoad || n.readAt) continue;
      toast(n.title, { description: n.message });
    }
  }, [data]);

  const [streamingReply, setStreamingReply] = React.useState<string | null>(null);
  const [streamingTools, setStreamingTools] = React.useState<
    Array<{ id: string; tool: string; label: string; status: "running" | "done" | "failed" }>
  >([]);
  const [streamingCards, setStreamingCards] = React.useState<ChatCard[]>([]);
  const [sendingChat, setSendingChat] = React.useState(false);

  const sendStreamingMessage = React.useCallback(
    async (text: string) => {
      setSendingChat(true);
      setStreamingReply("");
      setStreamingTools([]);
      setStreamingCards([]);
      isStreamingRef.current = true;

      await qc.cancelQueries({ queryKey: ["workspace", tripId] });
      const previous = qc.getQueryData<WorkspaceSnapshot>(["workspace", tripId]);
      const optimistic: WorkspaceMessage = {
        id: `optimistic_${Date.now()}`,
        role: "USER" as ChatRole,
        content: text,
        metadata: null,
        createdAt: new Date().toISOString(),
        author: previous?.me
          ? {
              id: previous.me.id,
              name: previous.me.name,
              imageUrl: previous.me.imageUrl,
            }
          : null,
      };
      qc.setQueryData<WorkspaceSnapshot>(["workspace", tripId], (prev) =>
        prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev,
      );

      try {
        const res = await fetch(`/api/trips/${tripId}/messages/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: text }),
        });
        if (res.status === 429) {
          toast.error("Slow down — you're sending too fast.");
          if (previous) qc.setQueryData(["workspace", tripId], previous);
          return;
        }
        if (!res.ok || !res.body) throw new Error("stream failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        // Silence-watchdog: if no SSE event arrives for 30s the stream
        // is wedged (DB hang, Anthropic timeout, partner-API stall).
        // Bail loudly so the user sees a real error instead of an
        // indefinite spinner. Reset every time we DO get an event.
        const SILENCE_TIMEOUT_MS = 30_000;
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        const resetSilenceTimer = () => {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            void reader.cancel().catch(() => {});
          }, SILENCE_TIMEOUT_MS);
        };
        resetSilenceTimer();
        while (true) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            throw new Error(
              "Lost connection to the concierge. The server stopped responding mid-reply — try again.",
            );
          }
          const { value, done } = chunk;
          if (done) {
            if (silenceTimer) clearTimeout(silenceTimer);
            break;
          }
          resetSilenceTimer();
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const block of events) {
            const dataLine = block
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const evt = JSON.parse(dataLine.slice(6));
              if (evt.type === "delta") {
                full += evt.text as string;
                setStreamingReply(full);
              } else if (evt.type === "tool_start") {
                setStreamingTools((prev) => [
                  ...prev,
                  {
                    id: evt.id as string,
                    tool: evt.tool as string,
                    label: evt.label as string,
                    status: "running",
                  },
                ]);
              } else if (evt.type === "tool_end") {
                setStreamingTools((prev) =>
                  prev.map((t) =>
                    t.id === evt.id
                      ? { ...t, status: evt.ok ? "done" : "failed" }
                      : t,
                  ),
                );
              } else if (evt.type === "card") {
                setStreamingCards((prev) => [...prev, evt.card as ChatCard]);
              } else if (evt.type === "done") {
                full = evt.full as string;
                const finalCards = (evt.cards as ChatCard[] | undefined) ?? [];
                // Optimistically inject the assistant reply into the
                // workspace cache BEFORE clearing the streaming bubble.
                // Without this there's a 200-500ms gap where the
                // streaming bubble disappears and the refetched message
                // hasn't arrived yet — the reply visibly flickers off
                // and back on. Same text, no flicker.
                qc.setQueryData<WorkspaceSnapshot>(
                  ["workspace", tripId],
                  (prev) =>
                    prev
                      ? {
                          ...prev,
                          messages: [
                            ...prev.messages,
                            {
                              id: `streamed_${Date.now()}`,
                              role: "ASSISTANT" as ChatRole,
                              content: full,
                              metadata: {
                                kind: "stream",
                                cards: finalCards.length > 0 ? finalCards : undefined,
                              },
                              createdAt: new Date().toISOString(),
                              author: null,
                            },
                          ],
                        }
                      : prev,
                );
                setStreamingReply(null);
                setStreamingTools([]);
                setStreamingCards([]);
              } else if (evt.type === "error") {
                // DON'T throw and rollback the optimistic user message —
                // that's what made the chat look silent. The server's
                // catch block has already persisted a fallback assistant
                // reply ("I hit a snag..." or the partial stream so far),
                // so we keep the user's message in place, surface a
                // toast, and let the background refetch swap in the
                // fallback reply. Cancel the reader so we exit cleanly.
                toast.error(
                  typeof evt.message === "string" && evt.message
                    ? evt.message
                    : "Concierge hit a snag — see the reply below.",
                );
                void reader.cancel().catch(() => {});
                break;
              }
            } catch {
              // ignore malformed events
            }
          }
        }
      } catch (err) {
        // True connection failure (network blip, server crash). Keep the
        // user's message in the cache — the server still has it and the
        // refetch will sync any partial assistant reply or fallback.
        console.error("[chat stream]", err);
        toast.error(
          err instanceof Error
            ? err.message
            : "Concierge didn't respond. Try again.",
        );
      } finally {
        // Force a refetch so any fallback reply the server saved shows up.
        void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
        setSendingChat(false);
        setStreamingReply(null);
        setStreamingTools([]);
        setStreamingCards([]);
        // Release the SSE refetch lock on the next tick so any late
        // 'snapshot.changed' events from the streaming flow (e.g. the
        // assistant-persist nudge) get coalesced. The first event that
        // arrives after this will fire the background-extraction refetch
        // and naturally swap our optimistic message for the persisted
        // one (same text → no visible flicker).
        setTimeout(() => {
          isStreamingRef.current = false;
        }, 100);
      }
    },
    [qc, tripId],
  );

  if (!data) {
    return <WorkspaceSkeleton />;
  }

  const snapshot = data;
  const chat = (
    <ConciergeChat
      tripId={tripId}
      trip={snapshot.trip}
      me={snapshot.me}
      messages={snapshot.messages}
      destinations={snapshot.destinations}
      approval={snapshot.approval}
      currentItineraryId={snapshot.itinerary?.id ?? null}
      onSend={(text) => void sendStreamingMessage(text)}
      sending={sendingChat}
      streamingReply={streamingReply}
      streamingTools={streamingTools}
      streamingCards={streamingCards}
      suggestions={suggestionsData?.suggestions ?? []}
    />
  );
  const preview = (
    <LivePreview
      tripId={tripId}
      trip={snapshot.trip}
      me={snapshot.me}
      itinerary={snapshot.itinerary}
      bookings={snapshot.bookings ?? []}
    />
  );

  // The quiz is the front door now. The chat workspace has been the
  // source of repeated confusion ("It says it booked but I see nothing")
  // because chat narrative != real booking. We render LivePreview as
  // the full result page so what the customer sees IS the trip — real
  // flights to click+book, real bookings as they happen, no
  // conversational text pretending things are confirmed when they
  // aren't. The chat component is retained in the codebase for power
  // users / future re-introduction but no longer rendered here.
  void chat;

  return (
    <>
      <PushPrompt vapidKey={vapidPublicKey ?? null} />

      <div className="container py-5">
        <div className="mx-auto max-w-3xl h-[calc(100dvh-7rem)]">{preview}</div>
      </div>
    </>
  );
}
