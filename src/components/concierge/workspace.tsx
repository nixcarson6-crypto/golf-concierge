"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConciergeChat } from "./chat";
import { LivePreview } from "./live-preview";
import { BookingStatusPanel } from "./booking-status-panel";
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
    /** IATA the customer asked for; null = no preference. Drives the honest
     *  "that airline isn't available on this route" note. */
    requestedAirline?: string | null;
    offers: SuggestedFlightOffer[];
    /** Per-leg breakdown for multi-destination trips. Undefined for
     *  single-destination trips (origin/destination cover everything). */
    legs?: Array<{
      index: number;
      destination: string;
      airport: string | null;
      startDate: string;
      endDate: string;
    }>;
    /** Full airport hop chain for multi-leg flights:
     *  [home, leg0, leg1, ..., home]. Undefined for single-leg. */
    airportChain?: string[];
  } | null;
  /** When false (the default), flights are SELF-BOOK — the customer books
   *  their own flight (their card pays the airline; we never front it). When
   *  true, Book All auto-books through Duffel after charging the customer. */
  flightAutoBook?: boolean;
  /** Multi-destination legs. Single-destination trips have exactly one
   *  leg with index = 0. Empty array for trips created before the
   *  TripLeg model landed. */
  legs: Array<{
    id: string;
    index: number;
    destination: string;
    startDate: string | null;
    endDate: string | null;
    airportIata: string | null;
  }>;
};

export type WorkspaceMe = {
  id: string;
  name: string | null;
  email: string;
  imageUrl: string | null;
  role: TripRole;
  myApproval: ApprovalStatus | null;
  myPayment: PaymentStatus | null;
  /** Has a card saved in the Stripe vault (gates agent end-to-end paid bookings). */
  hasSavedCard?: boolean;
  profile: {
    legalGivenName: string | null;
    legalFamilyName: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    phone: string | null;
    addressLine1?: string | null;
    addressCity?: string | null;
    addressState?: string | null;
    addressPostalCode?: string | null;
    addressCountry?: string | null;
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

export type WorkspaceItemBooking = {
  id: string;
  status:
    | "PENDING"
    | "SEARCHING"
    | "HELD"
    | "CONFIRMED"
    | "FAILED"
    | "CANCELLED"
    | "NEEDS_REVIEW";
  provider: string;
  confirmationCode: string | null;
  screenshotUrl: string | null;
  vendorUrl: string | null;
  agentRunId: string | null;
  /** Browserbase/Steel live-view URL — lets the customer watch the agent work
   *  in real time while the booking is in flight. */
  liveViewUrl?: string | null;
  failureReason: string | null;
  /** The venue's real total found at checkout (cents) — set when the agent
   *  paused for price approval. */
  quotedPriceCents?: number | null;
  /** The agent's own end-of-run summary (room/dates/price) — shown in the
   *  needs_review card so the customer sees exactly what was queued. */
  agentMessage?: string | null;
  fallbackContact: {
    website?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  amountChargedCents: number | null;
  agentProgress: string | null;
  agentStatus: string | null;
};

export type WorkspaceItineraryItem = {
  id: string;
  type: ItineraryItemType;
  title: string;
  description: string | null;
  location: string | null;
  startTime: string | null;
  endTime: string | null;
  /** IANA timezone of the item's location (e.g. "Asia/Singapore"). The
   *  startTime/endTime wall-clock is local to this zone; the UI renders the
   *  stored time in UTC to recover those digits and labels it with this. */
  timeZone?: string | null;
  cost: number | null;
  status: string | null;
  confirmationState: ConfirmationState;
  aiRationale: string | null;
  locked: boolean;
  /** Where a real (non-flight) price came from — source URL + a short
   *  basis label ("$525/night × 10 nights"). Null when the price wasn't
   *  confirmed or isn't applicable. */
  priceSource?: string | null;
  priceBasis?: string | null;
  /** Set by the build's walk-in detection pass for DINING + ACTIVITY:
   *   "required" — venue takes/needs a reservation (book it)
   *   "walk_in"  — Google says no reservation needed (show "walk in")
   *   "unknown"  — Google didn't say (treat as required by default)
   *   null       — type doesn't apply (LODGING/TEE_TIME/SPA etc.) */
  reservationNeed?: "required" | "walk_in" | "unknown" | null;
  /** Venue phone/website captured at build time for dining/activity/
   *  nightlife/spa — surfaced as Call / Draft-email / Visit-site actions
   *  since we don't auto-book those, we hand off the contact details. */
  contact?: { phone?: string | null; website?: string | null } | null;
  booking?: WorkspaceItemBooking | null;
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
  paymentMode: "pay_now" | "pay_at_property";
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
    // The booking agent runs in the BACKGROUND for minutes and writes its
    // result (Booked / Needs review / Failed + confirmation #) to the DB.
    // The UI must reflect that WITHOUT depending on the SSE bridge, which can
    // silently fail (notably the nudge→stream hop). So:
    //  - poll every 3s WHILE any booking is actively in flight, and stop once
    //    everything is terminal (no idle polling);
    //  - keep polling even when the tab is backgrounded — the customer is
    //    usually watching the booking happen on the venue tab — so the result
    //    is already there when they switch back;
    //  - refetch on focus + zero staleTime so returning to Pyltrix always
    //    shows the latest.
    refetchInterval: (query) => {
      const snap = query.state.data as WorkspaceSnapshot | undefined;
      const items = snap?.itinerary?.items ?? [];
      const ACTIVE = new Set(["PENDING", "SEARCHING", "HELD"]);
      return items.some((it) => it.booking && ACTIVE.has(it.booking.status))
        ? 6000
        : false;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // (Chat suggestions query removed — ConciergeChat is no longer
  // rendered after the UX pivot to result-page-first, so the
  // /suggestions endpoint was being called for nothing and spamming
  // the dev terminal with Anthropic 400s. The endpoint still exists
  // for future use but nothing in the live UI consumes it.)

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
  const preview = (
    <LivePreview
      tripId={tripId}
      trip={snapshot.trip}
      me={snapshot.me}
      itinerary={snapshot.itinerary}
      bookings={snapshot.bookings ?? []}
    />
  );
  const bookingStatus = (
    <BookingStatusPanel
      tripId={tripId}
      itinerary={snapshot.itinerary}
      hasSavedCard={snapshot.me.hasSavedCard}
      flightAutoBook={snapshot.trip.flightAutoBook ?? false}
      suggestedFlights={snapshot.trip.suggestedFlights}
      tripStartDate={snapshot.trip.startDate}
      tripEndDate={snapshot.trip.endDate}
      meProfile={snapshot.me.profile}
      meEmail={snapshot.me.email}
    />
  );

  // The quiz is the front door now. The chat workspace has been the
  // source of repeated confusion ("It says it booked but I see nothing")
  // because chat narrative != real booking. We render LivePreview as
  // the full result page so what the customer sees IS the trip — real
  // flights to click+book, real bookings as they happen, no
  // conversational text pretending things are confirmed when they
  // aren't.

  // Layout: the itinerary is the main column; the booking-status panel
  // sits beside it (right) on desktop and stacks below on mobile. The
  // panel is the customer's reassurance ledger — what's actually locked
  // in, live. It hides itself when there's no itinerary yet.
  const hasStatusPanel = Boolean(
    snapshot.itinerary &&
      snapshot.itinerary.items.some((i) => i.type !== "FREE_TIME"),
  );

  return (
    <>
      <PushPrompt vapidKey={vapidPublicKey ?? null} />

      <div className="container py-5">
        {hasStatusPanel ? (
          // Desktop: a fixed-height two-column grid with each pane scrolling
          // internally. Mobile (< lg): NO fixed heights — the panes stack and
          // grow with their content so the whole PAGE scrolls. Cramming the
          // itinerary + booking panel into fixed viewport boxes was what made
          // the cards look cut off on a phone.
          <div className="mx-auto max-w-6xl lg:h-[calc(100dvh-7rem)] lg:grid lg:grid-cols-12 lg:gap-5">
            <div className="lg:col-span-8 lg:h-full">{preview}</div>
            <div className="lg:col-span-4 mt-5 lg:mt-0 lg:h-full">
              {bookingStatus}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl lg:h-[calc(100dvh-7rem)]">
            {preview}
          </div>
        )}
      </div>
    </>
  );
}
