"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConciergeChat } from "./chat";
import { LivePreview } from "./live-preview";
import { StatusRail } from "./status-rail";
import type { ItineraryItemType, ConfirmationState, AgentType, AgentStatus, ChatRole, TripStatus } from "@prisma/client";

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

export type WorkspaceMessage = {
  id: string;
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
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
};

export type WorkspaceItinerary = {
  id: string;
  status: "DRAFT" | "CURRENT" | "APPROVED" | "SUPERSEDED";
  version: number;
  aiSummary: string | null;
  totalCost: number | null;
  perPersonCost: number | null;
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

type Props = {
  tripId: string;
  initialTrip: WorkspaceTrip;
  initialMessages: WorkspaceMessage[];
  initialItinerary: WorkspaceItinerary | null;
  initialAgentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  memberCount: number;
};

type WorkspaceSnapshot = {
  trip: WorkspaceTrip;
  messages: WorkspaceMessage[];
  itinerary: WorkspaceItinerary | null;
  agentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  memberCount: number;
};

export function ConciergeWorkspace(props: Props) {
  const qc = useQueryClient();
  const tripId = props.tripId;

  // Single canonical workspace snapshot, refetched on mutation + polled while
  // agents are running so the live preview stays in sync without WebSockets.
  const { data } = useQuery<WorkspaceSnapshot>({
    queryKey: ["workspace", tripId],
    queryFn: async () => {
      const res = await fetch(`/api/trips/${tripId}/workspace`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load workspace");
      return res.json();
    },
    initialData: {
      trip: props.initialTrip,
      messages: props.initialMessages,
      itinerary: props.initialItinerary,
      agentRuns: props.initialAgentRuns,
      destinationCount: props.destinationCount,
      memberCount: props.memberCount,
    },
    refetchInterval: (q) => {
      const snap = q.state.data as WorkspaceSnapshot | undefined;
      const hasActive = snap?.agentRuns.some(
        (r) => r.status === "RUNNING" || r.status === "QUEUED",
      );
      return hasActive ? 1500 : false;
    },
  });

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

  const snapshot: WorkspaceSnapshot = data!;

  return (
    <div className="container py-5">
      {/* Desktop: three-panel command center */}
      <div className="hidden lg:grid grid-cols-12 gap-5 h-[calc(100dvh-9.5rem)]">
        <section className="col-span-5 xl:col-span-4 min-h-0">
          <ConciergeChat
            tripId={tripId}
            trip={snapshot.trip}
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
          />
        </section>
        <section className="col-span-3 min-h-0">
          <StatusRail
            trip={snapshot.trip}
            itinerary={snapshot.itinerary}
            agentRuns={snapshot.agentRuns}
            destinationCount={snapshot.destinationCount}
            memberCount={snapshot.memberCount}
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
            />
          </TabsContent>
          <TabsContent value="status" className="h-[calc(100dvh-13rem)]">
            <StatusRail
              trip={snapshot.trip}
              itinerary={snapshot.itinerary}
              agentRuns={snapshot.agentRuns}
              destinationCount={snapshot.destinationCount}
              memberCount={snapshot.memberCount}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
