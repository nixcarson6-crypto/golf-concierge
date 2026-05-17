"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConciergeChat } from "./chat";
import { LivePreview } from "./live-preview";
import { StatusRail } from "./status-rail";
import { CommandPalette } from "./command-palette";
import { PushPrompt } from "./push-prompt";
import { toast } from "sonner";
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
  AuditAction,
} from "@prisma/client";

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
};

export type WorkspaceMe = {
  id: string;
  name: string | null;
  imageUrl: string | null;
  role: TripRole;
  myApproval: ApprovalStatus | null;
  myPayment: PaymentStatus | null;
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

type Props = { tripId: string; vapidPublicKey?: string | null };

function WorkspaceSkeleton() {
  return (
    <div className="container py-5">
      <div className="hidden lg:grid grid-cols-12 gap-5 h-[calc(100dvh-9.5rem)]">
        <div className="col-span-5 xl:col-span-4 rounded-3xl glass shimmer" />
        <div className="col-span-4 xl:col-span-5 rounded-3xl glass shimmer" />
        <div className="col-span-3 rounded-3xl glass shimmer" />
      </div>
      <div className="lg:hidden h-[calc(100dvh-13rem)] rounded-3xl glass shimmer" />
    </div>
  );
}

export type WorkspaceAuditEvent = {
  id: string;
  action: AuditAction;
  title: string;
  detail: string | null;
  actorKind: string;
  createdAt: string;
};

type WorkspaceSnapshot = {
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  messages: WorkspaceMessage[];
  itinerary: WorkspaceItinerary | null;
  agentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  members: WorkspaceMember[];
  approval: { approved: number; total: number; quorum: number };
  notifications: WorkspaceNotification[];
  summary: { shareToken: string | null; generatedAt: string } | null;
  auditEvents: WorkspaceAuditEvent[];
};

export function ConciergeWorkspace({ tripId, vapidPublicKey }: Props) {
  const qc = useQueryClient();
  const seenNotifications = React.useRef<Set<string>>(new Set());

  const { data } = useQuery<WorkspaceSnapshot>({
    queryKey: ["workspace", tripId],
    queryFn: async () => {
      const res = await fetch(`/api/trips/${tripId}/workspace`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load workspace");
      return res.json();
    },
  });

  // Live updates via Server-Sent Events. The server pings any time
  // anything material changes — we just invalidate to refetch.
  React.useEffect(() => {
    const es = new EventSource(`/api/trips/${tripId}/stream`);
    const refetch = () => qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    es.addEventListener("snapshot.changed", refetch);
    es.addEventListener("agent.progress", refetch);
    es.addEventListener("notification", refetch);
    es.addEventListener("ready", refetch);
    es.onerror = () => {
      // Browser will auto-reconnect. Nothing to do.
    };
    return () => es.close();
  }, [tripId, qc]);

  // Pop a Sonner toast for any newly-arrived notification. Initial set is
  // marked seen so we don't flood on first load.
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
  const [sendingChat, setSendingChat] = React.useState(false);

  const sendStreamingMessage = React.useCallback(
    async (text: string) => {
      setSendingChat(true);
      setStreamingReply("");

      // Optimistic user message
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
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
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
              } else if (evt.type === "done") {
                full = evt.full as string;
                setStreamingReply(null);
              } else if (evt.type === "error") {
                throw new Error(evt.message);
              }
            } catch {
              // ignore malformed events
            }
          }
        }
      } catch (err) {
        if (previous) qc.setQueryData(["workspace", tripId], previous);
        console.error("[chat stream]", err);
      } finally {
        setSendingChat(false);
        setStreamingReply(null);
        qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      }
    },
    [qc, tripId],
  );

  const itemAction = useMutation({
    mutationFn: async (args: {
      itemId: string;
      body: { action: "swap" | "upgrade" | "downgrade" | "regenerate" | "lock"; instruction?: string; locked?: boolean };
    }) => {
      const res = await fetch(
        `/api/trips/${tripId}/itinerary-items/${args.itemId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.body),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["workspace", tripId] }),
  });

  if (!data) {
    return <WorkspaceSkeleton />;
  }

  const snapshot = data;

  return (
    <>
      <PushPrompt vapidKey={vapidPublicKey ?? null} />
      <CommandPalette
        snapshot={snapshot}
        onSendMessage={(t) => void sendStreamingMessage(t)}
        onApprove={async () => {
          if (!snapshot.itinerary) return;
          await fetch(`/api/trips/${tripId}/approvals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              decision: "APPROVED",
              itineraryId: snapshot.itinerary.id,
            }),
          });
          qc.invalidateQueries({ queryKey: ["workspace", tripId] });
        }}
      />

      <div className="container py-5">
        {/* Desktop: three-panel command center */}
        <div className="hidden lg:grid grid-cols-12 gap-5 h-[calc(100dvh-9.5rem)]">
          <section className="col-span-5 xl:col-span-4 min-h-0">
            <ConciergeChat
              tripId={tripId}
              trip={snapshot.trip}
              me={snapshot.me}
              messages={snapshot.messages}
              onSend={(text) => void sendStreamingMessage(text)}
              sending={sendingChat}
              streamingReply={streamingReply}
            />
          </section>
          <section className="col-span-4 xl:col-span-5 min-h-0">
            <LivePreview
              tripId={tripId}
              trip={snapshot.trip}
              itinerary={snapshot.itinerary}
              me={snapshot.me}
              approval={snapshot.approval}
              onItemAction={(args) => itemAction.mutate(args)}
            />
          </section>
          <section className="col-span-3 min-h-0">
            <StatusRail
              tripId={tripId}
              trip={snapshot.trip}
              itinerary={snapshot.itinerary}
              agentRuns={snapshot.agentRuns}
              destinationCount={snapshot.destinationCount}
              members={snapshot.members}
              notifications={snapshot.notifications}
              approval={snapshot.approval}
              summary={snapshot.summary}
              auditEvents={snapshot.auditEvents}
              me={snapshot.me}
            />
          </section>
        </div>

        {/* Mobile: tabbed view */}
        <div className="lg:hidden">
          <Tabs defaultValue="chat" className="w-full">
            <TabsList className="w-full justify-start overflow-x-auto no-scrollbar">
              <TabsTrigger value="chat">Concierge</TabsTrigger>
              <TabsTrigger value="itinerary">Itinerary</TabsTrigger>
              <TabsTrigger value="status">Status</TabsTrigger>
            </TabsList>
            <TabsContent value="chat" className="h-[calc(100dvh-13rem)]">
              <ConciergeChat
                tripId={tripId}
                trip={snapshot.trip}
                me={snapshot.me}
                messages={snapshot.messages}
                onSend={(text) => void sendStreamingMessage(text)}
                sending={sendingChat}
                streamingReply={streamingReply}
              />
            </TabsContent>
            <TabsContent value="itinerary" className="h-[calc(100dvh-13rem)]">
              <LivePreview
                tripId={tripId}
                trip={snapshot.trip}
                itinerary={snapshot.itinerary}
                me={snapshot.me}
                approval={snapshot.approval}
                onItemAction={(args) => itemAction.mutate(args)}
              />
            </TabsContent>
            <TabsContent value="status" className="h-[calc(100dvh-13rem)]">
              <StatusRail
                tripId={tripId}
                trip={snapshot.trip}
                itinerary={snapshot.itinerary}
                agentRuns={snapshot.agentRuns}
                destinationCount={snapshot.destinationCount}
                members={snapshot.members}
                notifications={snapshot.notifications}
                approval={snapshot.approval}
                summary={snapshot.summary}
                auditEvents={snapshot.auditEvents}
                me={snapshot.me}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
