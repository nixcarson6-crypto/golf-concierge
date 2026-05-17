"use client";

import {
  Flag,
  BedDouble,
  UtensilsCrossed,
  Martini,
  Car,
  Plane,
  Coffee,
  Waves,
  Activity,
  Sparkles,
  Clock,
  MapPin,
  Lock,
} from "lucide-react";
import type { ConfirmationState, ItineraryItemType } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";
import {
  ItemActionsMenu,
  type ItemAction,
} from "@/components/itinerary/item-actions-menu";

export type DisplayItineraryItem = {
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
  locked?: boolean;
};

export function ItineraryItemCard({
  item,
  onAction,
  compact = false,
}: {
  item: DisplayItineraryItem;
  onAction?: (a: ItemAction) => void;
  compact?: boolean;
}) {
  const Icon = iconFor(item.type);
  return (
    <article
      className={cn(
        "group rounded-2xl border bg-card/60 p-4 transition",
        item.locked
          ? "border-[hsl(var(--gold)/0.35)] bg-[hsl(var(--gold)/0.04)]"
          : "border-border/70 hover:border-foreground/15",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "size-9 rounded-xl grid place-items-center shrink-0",
            tintFor(item.type),
          )}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {labelFor(item.type)}
                </p>
                {item.locked && (
                  <Lock className="size-2.5 text-[hsl(var(--gold))]" />
                )}
              </div>
              <h3 className="text-sm font-medium leading-tight mt-0.5 truncate">
                {item.title}
              </h3>
            </div>
            <div className="flex items-center gap-1.5">
              <ConfirmationBadge state={item.confirmationState} />
              {onAction && <ItemActionsMenu locked={Boolean(item.locked)} onAction={onAction} />}
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {item.startTime && (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {formatTime(item.startTime, item.endTime)}
              </span>
            )}
            {item.location && (
              <span className="inline-flex items-center gap-1 truncate">
                <MapPin className="size-3" />
                {item.location}
              </span>
            )}
            {item.cost != null && (
              <span className="num-tabular">
                {formatCurrency(item.cost / 100)}
              </span>
            )}
          </div>

          {!compact && item.aiRationale && (
            <div className="mt-3 rounded-xl bg-surface-raised/40 border border-border/50 px-3 py-2 text-xs text-muted-foreground flex gap-2 items-start">
              <Sparkles className="size-3 mt-0.5 text-[hsl(var(--gold))] shrink-0" />
              <span>{item.aiRationale}</span>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function ConfirmationBadge({ state }: { state: ConfirmationState }) {
  switch (state) {
    case "CONFIRMED":
      return (
        <Badge variant="emerald" size="sm">
          Confirmed
        </Badge>
      );
    case "HOLDING":
      return (
        <Badge variant="gold" size="sm">
          Holding
        </Badge>
      );
    case "SEARCHING":
    case "BOOKING":
      return (
        <Badge variant="gold" size="sm">
          <span className="size-1.5 rounded-full bg-[hsl(var(--gold))] animate-pulse-soft" />
          {state === "BOOKING" ? "Booking" : "Searching"}
        </Badge>
      );
    case "FAILED":
      return (
        <Badge variant="destructive" size="sm">
          Re-optimizing
        </Badge>
      );
    case "UNAVAILABLE":
      return (
        <Badge variant="warning" size="sm">
          Unavailable
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge variant="muted" size="sm">
          Cancelled
        </Badge>
      );
    default:
      return (
        <Badge variant="muted" size="sm">
          Proposed
        </Badge>
      );
  }
}

function iconFor(type: ItineraryItemType) {
  switch (type) {
    case "TEE_TIME":
      return Flag;
    case "LODGING":
      return BedDouble;
    case "DINING":
      return UtensilsCrossed;
    case "NIGHTLIFE":
      return Martini;
    case "TRANSPORT":
      return Car;
    case "FLIGHT":
      return Plane;
    case "FREE_TIME":
      return Coffee;
    case "SPA":
      return Waves;
    case "ACTIVITY":
      return Activity;
  }
}

function tintFor(type: ItineraryItemType) {
  switch (type) {
    case "TEE_TIME":
      return "bg-[hsl(var(--emerald)/0.12)] text-[hsl(var(--emerald))] border border-[hsl(var(--emerald)/0.25)]";
    case "LODGING":
      return "bg-[hsl(var(--gold)/0.12)] text-[hsl(var(--gold))] border border-[hsl(var(--gold)/0.25)]";
    case "DINING":
    case "NIGHTLIFE":
      return "bg-[hsl(var(--gold)/0.08)] text-[hsl(var(--gold))] border border-[hsl(var(--gold)/0.18)]";
    default:
      return "bg-surface-raised text-muted-foreground border border-border";
  }
}

function labelFor(type: ItineraryItemType) {
  switch (type) {
    case "TEE_TIME":
      return "Tee time";
    case "LODGING":
      return "Lodging";
    case "DINING":
      return "Dining";
    case "NIGHTLIFE":
      return "Nightlife";
    case "TRANSPORT":
      return "Transport";
    case "FLIGHT":
      return "Flight";
    case "FREE_TIME":
      return "Free time";
    case "SPA":
      return "Spa";
    case "ACTIVITY":
      return "Activity";
  }
}

function formatTime(start: string, end: string | null) {
  const s = new Date(start);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  };
  if (!end) return s.toLocaleString("en-US", opts);
  const e = new Date(end);
  const sameDay = s.toDateString() === e.toDateString();
  if (sameDay) {
    return `${s.toLocaleString("en-US", opts)} – ${e.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  return `${s.toLocaleString("en-US", opts)} → ${e.toLocaleString("en-US", opts)}`;
}
