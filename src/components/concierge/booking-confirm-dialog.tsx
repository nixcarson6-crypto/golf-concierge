"use client";

/**
 * Pre-book "Review & confirm" dialog — Carson's call (June 2026, reversing
 * the earlier no-friction stance now that real money flows): EVERY booking
 * trigger (single-item agent booking AND Book All) shows a compact summary
 * — what's being committed, when, the price, and how it's paid — behind one
 * Confirm tap before anything executes. Used by AgentBookingPanel,
 * BookingStatusPanel, and the LivePreview Book All CTA so the experience is
 * identical regardless of which lane (LiteAPI / Hotelbeds / browser agent /
 * Duffel) ends up doing the booking.
 */

import * as React from "react";
import { BadgeCheck, CalendarDays, CreditCard, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmLine = {
  title: string;
  /** e.g. "Sat, Aug 22 · 2 guests" — anything that orients the customer. */
  detail?: string | null;
  /** Cents. Null → "price confirmed at checkout". */
  costCents?: number | null;
};

export function BookingConfirmDialog({
  open,
  onOpenChange,
  heading = "Review & confirm",
  lines,
  totalCents,
  paymentNote,
  confirmLabel = "Confirm & book",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  heading?: string;
  lines: ConfirmLine[];
  /** Shown as a total bar when there's more than one line. Cents. */
  totalCents?: number | null;
  /** One honest sentence about how the money works. */
  paymentNote: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden rounded-2xl">
        <div className="px-5 pt-5 pb-4 border-b border-border/60">
          <DialogTitle className="text-display text-xl tracking-tight">
            {heading}
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Nothing is booked until you confirm.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[50vh] overflow-y-auto">
          {lines.map((l, i) => (
            <div key={`${l.title}-${i}`} className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken/50">
                <CalendarDays className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium tracking-tight truncate">
                  {l.title}
                </p>
                {l.detail ? (
                  <p className="text-xs text-muted-foreground truncate">
                    {l.detail}
                  </p>
                ) : null}
              </div>
              <p className="text-sm tabular-nums shrink-0">
                {typeof l.costCents === "number"
                  ? `$${Math.round(l.costCents / 100).toLocaleString()}`
                  : "at checkout"}
              </p>
            </div>
          ))}

          {lines.length > 1 && typeof totalCents === "number" ? (
            <div className="flex items-center justify-between border-t border-border pt-3 mt-1">
              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Estimated total
              </p>
              <p className="text-display text-lg tabular-nums tracking-tight">
                ${Math.round(totalCents / 100).toLocaleString()}
              </p>
            </div>
          ) : null}

          <p className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed pt-1">
            <CreditCard className="size-3.5 mt-0.5 shrink-0" strokeWidth={2} />
            {paymentNote}
          </p>
        </div>

        <div className="px-5 py-4 border-t border-border/60 flex gap-2">
          <Button
            variant="outline"
            className="flex-1 h-11 rounded-xl"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            className="flex-1 h-11 rounded-xl bg-accent text-accent-foreground hover:bg-accent/90 font-semibold"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <BadgeCheck className="size-4 mr-2" />
            )}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Sat, Aug 22, 2026 · 7:30 PM" from a stored wall-clock ISO + tz label.
 *  Items store local wall-clock; rendering in UTC recovers those digits. */
export function confirmDetailFor(item: {
  startTime: string | null;
  location?: string | null;
}): string | null {
  if (!item.startTime) return item.location ?? null;
  try {
    const d = new Date(item.startTime);
    const date = d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    return time === "12:00 AM" ? date : `${date} · ${time}`;
  } catch {
    return item.location ?? null;
  }
}
