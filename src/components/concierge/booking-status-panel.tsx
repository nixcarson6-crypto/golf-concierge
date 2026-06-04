"use client";

/**
 * The booking-status side panel.
 *
 * A tall, glanceable checklist that sits beside the itinerary on the
 * result page. Every bookable item shows its live state — Booked ✓ with
 * confirmation number + amount, Booking… (agent working), Reviewing,
 * Needs you, or Not booked yet. A "X of Y confirmed" header + thin
 * progress bar gives the customer the one thing autonomous booking has
 * to earn: the feeling that it actually happened.
 *
 * Derives entirely from itinerary.items[].booking — no extra fetch.
 * Updates live as the workspace snapshot refetches (SSE + the agent
 * panel's 3s poll).
 */

import * as React from "react";
import {
  Check,
  Loader2,
  Circle,
  AlertCircle,
  ShieldCheck,
  Plane,
  BedDouble,
  Flag,
  UtensilsCrossed,
  Wine,
  Car,
  Flower2,
  Sparkles,
  PartyPopper,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceItinerary, WorkspaceItineraryItem } from "./workspace";

type RowStatus = "confirmed" | "booking" | "review" | "failed" | "pending";

function statusFor(item: WorkspaceItineraryItem): {
  kind: RowStatus;
  code: string | null;
  amountCents: number | null;
} {
  const b = item.booking ?? null;
  if (!b) return { kind: "pending", code: null, amountCents: null };
  switch (b.status) {
    case "CONFIRMED":
      return {
        kind: "confirmed",
        code: b.confirmationCode ?? null,
        amountCents: b.amountChargedCents ?? item.cost ?? null,
      };
    case "SEARCHING":
    case "PENDING":
    case "HELD":
      return { kind: "booking", code: null, amountCents: null };
    case "NEEDS_REVIEW":
      return { kind: "review", code: null, amountCents: null };
    case "FAILED":
    case "CANCELLED":
      return { kind: "failed", code: null, amountCents: null };
    default:
      return { kind: "pending", code: null, amountCents: null };
  }
}

function TypeIcon({ type }: { type: WorkspaceItineraryItem["type"] }) {
  const cls = "size-3.5 text-foreground/70";
  switch (type) {
    case "FLIGHT":
      return <Plane className={cls} />;
    case "LODGING":
      return <BedDouble className={cls} />;
    case "TEE_TIME":
      return <Flag className={cls} />;
    case "DINING":
      return <UtensilsCrossed className={cls} />;
    case "NIGHTLIFE":
      return <Wine className={cls} />;
    case "TRANSPORT":
      return <Car className={cls} />;
    case "SPA":
      return <Flower2 className={cls} />;
    default:
      return <Sparkles className={cls} />;
  }
}

function StatusBadge({ kind }: { kind: RowStatus }) {
  switch (kind) {
    case "confirmed":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-foreground text-background shrink-0">
          <Check className="size-3" strokeWidth={3} />
        </span>
      );
    case "booking":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <Loader2 className="size-3.5 animate-spin text-foreground" />
        </span>
      );
    case "review":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <ShieldCheck className="size-3.5 text-foreground" />
        </span>
      );
    case "failed":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <AlertCircle className="size-3.5 text-foreground" />
        </span>
      );
    default:
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <Circle className="size-3 text-muted-foreground/40" />
        </span>
      );
  }
}

function statusLabel(kind: RowStatus): string {
  switch (kind) {
    case "confirmed":
      return "Booked";
    case "booking":
      return "Booking…";
    case "review":
      return "Reviewing";
    case "failed":
      return "Needs you";
    default:
      return "Not booked yet";
  }
}

export function BookingStatusPanel({
  itinerary,
}: {
  itinerary: WorkspaceItinerary | null;
}) {
  // Everything that's meant to be booked. FREE_TIME isn't a reservation.
  const items = React.useMemo(
    () => (itinerary?.items ?? []).filter((i) => i.type !== "FREE_TIME"),
    [itinerary],
  );

  if (!itinerary || items.length === 0) return null;

  const rows = items.map((item) => ({ item, ...statusFor(item) }));
  const total = rows.length;
  const confirmed = rows.filter((r) => r.kind === "confirmed").length;
  const inFlight = rows.filter((r) => r.kind === "booking").length;
  const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;
  const allDone = confirmed === total;

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      {/* Header */}
      <header className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Booking status
          </p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {confirmed} of {total} confirmed
          </p>
        </div>
        {/* Progress hairline */}
        <div className="mt-3 h-px w-full bg-border overflow-hidden">
          <div
            className="h-full bg-foreground transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2.5 text-xs text-muted-foreground leading-snug">
          {allDone
            ? "Everything's locked in. You're all set."
            : inFlight > 0
              ? "Pyltrix is booking your trip — watch each line confirm."
              : "Tap “Book all” or “Book it for me” and items confirm here."}
        </p>
      </header>

      {/* Rows */}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2.5 py-2">
        {rows.map(({ item, kind, code, amountCents }) => (
          <div
            key={item.id}
            className="flex items-start gap-2.5 rounded-xl px-2.5 py-2.5 hover:bg-surface-raised/50 transition"
          >
            <StatusBadge kind={kind} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <TypeIcon type={item.type} />
                <p
                  className={cn(
                    "text-[13px] leading-snug truncate",
                    kind === "confirmed"
                      ? "font-medium text-foreground"
                      : "text-foreground/80",
                  )}
                >
                  {item.title}
                </p>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{statusLabel(kind)}</span>
                {code && (
                  <span className="tabular-nums">· #{code}</span>
                )}
                {amountCents != null && amountCents > 0 && (
                  <span className="tabular-nums">
                    · ${Math.round(amountCents / 100).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer — the trophy state */}
      {allDone && (
        <footer className="px-5 py-4 border-t border-border/60 flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-foreground text-background shrink-0">
            <PartyPopper className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium">You&apos;re all set</p>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Confirmations are on their way to your inbox.
            </p>
          </div>
        </footer>
      )}
    </div>
  );
}
