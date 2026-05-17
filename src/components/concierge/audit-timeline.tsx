"use client";

import * as React from "react";
import {
  CalendarRange,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Compass,
  CreditCard,
  ScrollText,
  Lock,
  Replace,
} from "lucide-react";
import type { AuditAction } from "@prisma/client";
import { cn, relativeTime } from "@/lib/utils";

export type AuditEvent = {
  id: string;
  action: AuditAction;
  title: string;
  detail: string | null;
  actorKind: string;
  createdAt: string;
};

export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/80">
        Activity will appear here as the concierge works.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {events.slice(0, 12).map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface-raised/30 px-3 py-2"
        >
          <Icon action={e.action} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium leading-tight">{e.title}</p>
            {e.detail && (
              <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                {e.detail}
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">
              {relativeTime(e.createdAt)} · {e.actorKind}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Icon({ action }: { action: AuditAction }) {
  const { node, tint } = iconFor(action);
  return (
    <span
      className={cn(
        "size-6 rounded-md grid place-items-center shrink-0 mt-0.5",
        tint,
      )}
    >
      {node}
    </span>
  );
}

function iconFor(action: AuditAction): {
  node: React.ReactNode;
  tint: string;
} {
  switch (action) {
    case "TRIP_CREATED":
    case "TRIP_UPDATED":
    case "CONSTRAINTS_UPDATED":
      return {
        node: <Sparkles className="size-3" />,
        tint: "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))]",
      };
    case "DESTINATION_SELECTED":
      return {
        node: <Compass className="size-3" />,
        tint: "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))]",
      };
    case "ITINERARY_DRAFTED":
    case "ITINERARY_REVISED":
      return {
        node: <CalendarRange className="size-3" />,
        tint: "bg-[hsl(var(--emerald)/0.12)] text-[hsl(var(--emerald))]",
      };
    case "ITEM_SWAPPED":
      return {
        node: <Replace className="size-3" />,
        tint: "bg-surface-raised text-muted-foreground",
      };
    case "ITEM_LOCKED":
    case "ITEM_UNLOCKED":
      return {
        node: <Lock className="size-3" />,
        tint: "bg-surface-raised text-muted-foreground",
      };
    case "ITINERARY_APPROVED":
      return {
        node: <CheckCircle2 className="size-3" />,
        tint: "bg-[hsl(var(--emerald)/0.12)] text-[hsl(var(--emerald))]",
      };
    case "BOOKING_REQUESTED":
    case "BOOKING_HELD":
      return {
        node: <CalendarRange className="size-3" />,
        tint: "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))]",
      };
    case "BOOKING_CONFIRMED":
      return {
        node: <CheckCircle2 className="size-3" />,
        tint: "bg-[hsl(var(--emerald)/0.12)] text-[hsl(var(--emerald))]",
      };
    case "BOOKING_FAILED":
      return {
        node: <AlertCircle className="size-3" />,
        tint: "bg-[hsl(var(--destructive)/0.12)] text-[hsl(var(--destructive))]",
      };
    case "PAYMENT_REQUESTED":
    case "PAYMENT_RECEIVED":
      return {
        node: <CreditCard className="size-3" />,
        tint: "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))]",
      };
    case "SUMMARY_GENERATED":
      return {
        node: <ScrollText className="size-3" />,
        tint: "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))]",
      };
    default:
      return {
        node: <Sparkles className="size-3" />,
        tint: "bg-surface-raised text-muted-foreground",
      };
  }
}
