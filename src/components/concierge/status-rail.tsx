"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sparkles,
  Compass,
  CalendarRange,
  CreditCard,
  Users,
  Activity,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Bell,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, initials, relativeTime } from "@/lib/utils";
import { tripStatusLabel } from "@/lib/trip-status";
import type {
  WorkspaceAgentRun,
  WorkspaceItinerary,
  WorkspaceMember,
  WorkspaceNotification,
  WorkspaceTrip,
} from "./workspace";
import type { AgentType } from "@prisma/client";

export function StatusRail({
  tripId,
  trip,
  itinerary,
  agentRuns,
  destinationCount,
  members,
  notifications,
  approval,
  summary,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
  agentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  members: WorkspaceMember[];
  notifications: WorkspaceNotification[];
  approval: { approved: number; total: number; quorum: number };
  summary: { shareToken: string | null; generatedAt: string } | null;
}) {
  const qc = useQueryClient();
  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    await fetch(`/api/trips/${tripId}/notifications/read`, { method: "POST" });
    qc.invalidateQueries({ queryKey: ["workspace", tripId] });
  };

  return (
    <aside className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Status
            </p>
            <h2 className="text-display text-lg tracking-tight">
              {tripStatusLabel(trip.status)}
            </h2>
          </div>
          <button
            onClick={markAllRead}
            className="relative size-9 grid place-items-center rounded-lg border border-border/70 bg-surface-raised/40 text-muted-foreground hover:text-foreground transition"
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 size-4 rounded-full bg-[hsl(var(--gold))] text-[10px] text-[hsl(var(--primary-foreground))] font-medium grid place-items-center">
                {unreadCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="px-5 py-5 space-y-6">
          <section>
            <SectionHeading>Progress</SectionHeading>
            <ul className="mt-3 space-y-2">
              <ProgressRow
                icon={<Compass className="size-3.5" />}
                label="Destination"
                state={
                  trip.destination
                    ? "done"
                    : destinationCount > 0
                      ? "active"
                      : "pending"
                }
                detail={
                  trip.destination ??
                  (destinationCount > 0
                    ? `${destinationCount} options ready`
                    : "Awaiting input")
                }
                href={`/trips/${tripId}/destination`}
              />
              <ProgressRow
                icon={<CalendarRange className="size-3.5" />}
                label="Itinerary"
                state={
                  itinerary?.status === "APPROVED"
                    ? "done"
                    : itinerary
                      ? "active"
                      : "pending"
                }
                detail={
                  itinerary
                    ? `v${itinerary.version} · ${itinerary.items.length} items`
                    : "Not yet drafted"
                }
                href={`/trips/${tripId}/itinerary`}
              />
              <ProgressRow
                icon={<Users className="size-3.5" />}
                label="Group"
                state={
                  approval.approved === approval.total && approval.total > 0
                    ? "done"
                    : approval.approved > 0
                      ? "active"
                      : "pending"
                }
                detail={
                  members.length > 0
                    ? `${approval.approved}/${approval.total} approved`
                    : "No members yet"
                }
                href={`/trips/${tripId}/group`}
              />
              <ProgressRow
                icon={<CreditCard className="size-3.5" />}
                label="Payments"
                state={
                  members.every((m) => m.paymentStatus === "PAID") &&
                  members.length > 0
                    ? "done"
                    : members.some((m) => m.paymentStatus !== "UNPAID")
                      ? "active"
                      : "pending"
                }
                detail={
                  members.length > 0
                    ? `${members.filter((m) => m.paymentStatus === "PAID").length}/${members.length} paid`
                    : "Awaiting members"
                }
                href={`/trips/${tripId}/payments`}
              />
            </ul>
          </section>

          {members.length > 0 && (
            <section>
              <SectionHeading>
                <Users className="size-3" /> Group
              </SectionHeading>
              <div className="mt-3 flex flex-wrap -space-x-1.5">
                {members.slice(0, 7).map((m) => (
                  <Avatar
                    key={m.id}
                    className={cn(
                      "size-7 ring-2 ring-card",
                      m.approvalStatus === "APPROVED" &&
                        "ring-[hsl(var(--emerald)/0.6)]",
                    )}
                    title={`${m.name ?? m.email} · ${m.approvalStatus.replace("_", " ").toLowerCase()}`}
                  >
                    {m.imageUrl && (
                      <AvatarImage src={m.imageUrl} alt={m.name ?? m.email} />
                    )}
                    <AvatarFallback className="text-[10px]">
                      {initials(m.name ?? m.email)}
                    </AvatarFallback>
                  </Avatar>
                ))}
                {members.length > 7 && (
                  <div className="size-7 ring-2 ring-card rounded-full bg-surface-raised border border-border grid place-items-center text-[10px] text-muted-foreground">
                    +{members.length - 7}
                  </div>
                )}
              </div>
            </section>
          )}

          <section>
            <SectionHeading>
              <Activity className="size-3" /> Agent activity
            </SectionHeading>
            <ul className="mt-3 space-y-2">
              {agentRuns.length === 0 ? (
                <li className="text-xs text-muted-foreground/80">
                  No agents have run yet.
                </li>
              ) : (
                agentRuns.map((r) => <AgentRunRow key={r.id} run={r} />)
              )}
            </ul>
          </section>

          {notifications.length > 0 && (
            <section>
              <SectionHeading>
                <Bell className="size-3" /> Recent activity
              </SectionHeading>
              <ul className="mt-3 space-y-2">
                {notifications.slice(0, 5).map((n) => (
                  <li
                    key={n.id}
                    className={cn(
                      "rounded-xl border px-3 py-2.5",
                      n.readAt
                        ? "border-border/40 bg-surface-raised/20"
                        : "border-[hsl(var(--gold)/0.3)] bg-[hsl(var(--gold)/0.05)]",
                    )}
                  >
                    <p className="text-xs font-medium leading-tight">{n.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {n.message}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {relativeTime(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {summary?.shareToken && (
            <section>
              <SectionHeading>
                <Share2 className="size-3" /> Share
              </SectionHeading>
              <Link
                href={`/s/${summary.shareToken}`}
                target="_blank"
                className="mt-3 inline-flex items-center gap-2 text-xs rounded-xl border border-border/70 bg-surface-raised/40 px-3 py-2 hover:bg-surface-raised hover:border-foreground/20 transition"
              >
                <Sparkles className="size-3 text-[hsl(var(--gold))]" />
                Open shareable summary
              </Link>
            </section>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

function ProgressRow({
  icon,
  label,
  state,
  detail,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  state: "done" | "active" | "pending";
  detail: string;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface-raised/30 px-3 py-2.5 hover:border-foreground/15 hover:bg-surface-raised/60 transition"
      >
        <span
          className={cn(
            "size-7 rounded-lg grid place-items-center",
            state === "done"
              ? "bg-[hsl(var(--emerald)/0.12)] text-[hsl(var(--emerald))] border border-[hsl(var(--emerald)/0.25)]"
              : state === "active"
                ? "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))] border border-[hsl(var(--gold)/0.25)]"
                : "bg-surface text-muted-foreground border border-border",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-tight">{label}</p>
          <p className="text-[11px] text-muted-foreground truncate">{detail}</p>
        </div>
      </Link>
    </li>
  );
}

function AgentRunRow({ run }: { run: WorkspaceAgentRun }) {
  return (
    <li className="rounded-xl border border-border/60 bg-surface-raised/30 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <AgentIcon status={run.status} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-tight truncate">
            {agentLabel(run.agentType)}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {run.progress ?? statusText(run.status)}
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground/70">
          {relativeTime(run.startedAt ?? new Date().toISOString())}
        </span>
      </div>
    </li>
  );
}

function AgentIcon({ status }: { status: WorkspaceAgentRun["status"] }) {
  if (status === "RUNNING" || status === "QUEUED") {
    return (
      <span className="size-6 rounded-md bg-[hsl(var(--gold)/0.12)] grid place-items-center text-[hsl(var(--gold))]">
        <Loader2 className="size-3 animate-spin" />
      </span>
    );
  }
  if (status === "SUCCEEDED") {
    return (
      <span className="size-6 rounded-md bg-[hsl(var(--emerald)/0.12)] grid place-items-center text-[hsl(var(--emerald))]">
        <CheckCircle2 className="size-3" />
      </span>
    );
  }
  return (
    <span className="size-6 rounded-md bg-[hsl(var(--destructive)/0.12)] grid place-items-center text-[hsl(var(--destructive))]">
      <AlertCircle className="size-3" />
    </span>
  );
}

function agentLabel(t: AgentType) {
  switch (t) {
    case "CONSTRAINT_EXTRACTOR":
      return "Concierge";
    case "DESTINATION":
      return "Destination agent";
    case "ITINERARY":
      return "Itinerary agent";
    case "TEE_TIME":
      return "Tee time agent";
    case "LODGING":
      return "Lodging agent";
    case "FLIGHT":
      return "Flight agent";
    case "TRANSPORT":
      return "Transport agent";
    case "DINING":
      return "Dining agent";
    case "BUDGET":
      return "Budget agent";
    case "FALLBACK":
      return "Re-optimization agent";
    case "PAYMENT":
      return "Payment agent";
    case "SUMMARY":
      return "Summary agent";
  }
}

function statusText(s: WorkspaceAgentRun["status"]) {
  return s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ");
}
