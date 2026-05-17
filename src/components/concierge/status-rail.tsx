"use client";

import Link from "next/link";
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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, relativeTime } from "@/lib/utils";
import { tripStatusLabel } from "@/lib/trip-status";
import type {
  WorkspaceAgentRun,
  WorkspaceItinerary,
  WorkspaceTrip,
} from "./workspace";
import type { AgentType } from "@prisma/client";

export function StatusRail({
  trip,
  itinerary,
  agentRuns,
  destinationCount,
  memberCount,
}: {
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
  agentRuns: WorkspaceAgentRun[];
  destinationCount: number;
  memberCount: number;
}) {
  return (
    <aside className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Status
        </p>
        <div className="mt-1 flex items-center justify-between">
          <h2 className="text-display text-lg tracking-tight">
            {tripStatusLabel(trip.status)}
          </h2>
          <Sparkles className="size-4 text-[hsl(var(--gold))]" />
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
                href={`/trips/${trip.id}/destination`}
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
                href={`/trips/${trip.id}/itinerary`}
              />
              <ProgressRow
                icon={<Users className="size-3.5" />}
                label="Group"
                state={memberCount > 1 ? "done" : "pending"}
                detail={`${memberCount} ${memberCount === 1 ? "member" : "members"}`}
                href={`/trips/${trip.id}/group`}
              />
              <ProgressRow
                icon={<CreditCard className="size-3.5" />}
                label="Payments"
                state={trip.status === "BOOKED" ? "done" : "pending"}
                detail="Awaiting approval"
                href={`/trips/${trip.id}/payments`}
              />
            </ul>
          </section>

          <section>
            <SectionHeading>
              <Activity className="size-3" /> Agent activity
            </SectionHeading>
            <ul className="mt-3 space-y-2">
              {agentRuns.length === 0 ? (
                <li className="text-xs text-muted-foreground/80">
                  No agents have run yet. Send a message to get started.
                </li>
              ) : (
                agentRuns.map((r) => <AgentRunRow key={r.id} run={r} />)
              )}
            </ul>
          </section>
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

export { Badge };
