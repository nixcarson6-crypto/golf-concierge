"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConciergeChat } from "./chat";
import { LivePreview } from "./live-preview";
import { StatusRail } from "./status-rail";
import { CommandPalette } from "./command-palette";
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

type Props = { tripId: string };

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
};

export function ConciergeWorkspace({ tripId }: Props) {
  const qc = useQueryClient();

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

  const sendMessage = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/trips/${tripId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: ["workspace", tripId] });
      const previous = qc.getQueryData<WorkspaceSnapshot>(["workspace", tripId]);
      const optimistic: WorkspaceMessage = {
        id: `optimistic_${Date.now()}`,
        role: "USER" as ChatRole,
        content: text,
        metadata: null,
        createdAt: new Date().toISOString(),
        author: previous?.me
          ? { id: previous.me.id, name: previous.me.name, imageUrl: previous.me.imageUrl }
          : null,
      };
      const thinking: WorkspaceAgentRun = {
        id: `optimistic_run_${Date.now()}`,
        agentType: "CONSTRAINT_EXTRACTOR" as AgentType,
        status: "RUNNING" as AgentStatus,
        progress: "Thinking…",
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      qc.setQueryData<WorkspaceSnapshot>(["workspace", tripId], (prev) =>
        prev
          ? {
              ...prev,
              messages: [...prev.messages, optimistic],
              agentRuns: [thinking, ...prev.agentRuns].slice(0, 8),
            }
          : prev,
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["workspace", tripId], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["workspace", tripId] }),
  });

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
    return (
      <div className="container py-20 text-center text-muted-foreground text-sm">
        Loading concierge…
      </div>
    );
  }

  const snapshot = data;

  return (
    <>
      <CommandPalette
        snapshot={snapshot}
        onSendMessage={(t) => sendMessage.mutate(t)}
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
              onSend={(text) => sendMessage.mutate(text)}
              sending={sendMessage.isPending}
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
                onSend={(text) => sendMessage.mutate(text)}
                sending={sendMessage.isPending}
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
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
