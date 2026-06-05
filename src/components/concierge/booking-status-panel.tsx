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
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
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
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  WorkspaceItinerary,
  WorkspaceItineraryItem,
} from "./workspace";

// Item types the browser agent can book directly (matches
// AgentBookingPanel). Flights go through "Book all" (Duffel), FREE_TIME
// isn't a reservation, TRANSPORT is an Uber deep-link — so those rows
// aren't tap-to-book here.
const AGENT_BOOKABLE = new Set([
  "LODGING",
  "TEE_TIME",
  "DINING",
  "NIGHTLIFE",
  "SPA",
  "ACTIVITY",
]);

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

// Group items into a few high-level buckets so a 40-line wall of rows
// reads as 5 sections of 5-10 things each. Order is the customer's
// reading order — what to fly into first, where to sleep, what to
// play, what to eat, what to do, then plumbing (transport).
type CategoryKey =
  | "FLIGHTS"
  | "HOTELS"
  | "GOLF"
  | "DINING"
  | "ACTIVITIES"
  | "TRANSPORT";

const CATEGORY_ORDER: CategoryKey[] = [
  "FLIGHTS",
  "HOTELS",
  "GOLF",
  "DINING",
  "ACTIVITIES",
  "TRANSPORT",
];

const CATEGORY_META: Record<
  CategoryKey,
  { label: string; icon: React.ReactNode }
> = {
  FLIGHTS: { label: "Flights", icon: <Plane className="size-3.5" /> },
  HOTELS: { label: "Hotels", icon: <BedDouble className="size-3.5" /> },
  GOLF: { label: "Golf", icon: <Flag className="size-3.5" /> },
  DINING: { label: "Dining", icon: <UtensilsCrossed className="size-3.5" /> },
  ACTIVITIES: {
    label: "Activities",
    icon: <Sparkles className="size-3.5" />,
  },
  TRANSPORT: { label: "Transport", icon: <Car className="size-3.5" /> },
};

function categoryFor(type: WorkspaceItineraryItem["type"]): CategoryKey {
  switch (type) {
    case "FLIGHT":
      return "FLIGHTS";
    case "LODGING":
      return "HOTELS";
    case "TEE_TIME":
      return "GOLF";
    case "DINING":
      return "DINING";
    case "TRANSPORT":
      return "TRANSPORT";
    case "NIGHTLIFE":
    case "SPA":
    case "ACTIVITY":
    default:
      return "ACTIVITIES";
  }
}

export function BookingStatusPanel({
  tripId,
  itinerary,
}: {
  tripId: string;
  itinerary: WorkspaceItinerary | null;
}) {
  const qc = useQueryClient();
  const [bookingId, setBookingId] = React.useState<string | null>(null);
  const [bookingAll, setBookingAll] = React.useState(false);

  const bookAll = React.useCallback(async () => {
    if (bookingAll || bookingId) return;
    setBookingAll(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/book-all`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        needsProfile?: boolean;
        error?: string;
        outcomes?: Array<{ status: string }>;
      } | null;
      if (!res.ok || !data?.ok) {
        toast.error(
          data?.error ?? "Couldn't book the trip — try again.",
        );
        return;
      }
      const booked =
        data.outcomes?.filter((o) => o.status === "booked").length ?? 0;
      const pencilled =
        data.outcomes?.filter((o) => o.status === "pencilled").length ?? 0;
      const failed =
        data.outcomes?.filter((o) => o.status === "failed").length ?? 0;
      if (failed > 0) {
        toast.error(
          `Booked ${booked}, pencilled ${pencilled}, ${failed} failed — check the panel.`,
        );
      } else {
        toast.success(
          `Trip locked in: ${booked} confirmed${pencilled > 0 ? `, ${pencilled} pencilled` : ""}.`,
        );
      }
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBookingAll(false);
    }
  }, [bookingAll, bookingId, qc, tripId]);

  // Tap a not-yet-booked row to have the agent book just that one.
  const bookItem = React.useCallback(
    async (item: WorkspaceItineraryItem) => {
      if (bookingId) return;
      setBookingId(item.id);
      try {
        const res = await fetch(
          `/api/trips/${tripId}/items/${item.id}/book-agent`,
          { method: "POST" },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          toast.error(err?.error ?? "Couldn't start that booking — try again.");
          return;
        }
        toast.success(`Pyltrix is booking ${item.title}.`);
        void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      } catch {
        toast.error("Network error — try again.");
      } finally {
        setBookingId(null);
      }
    },
    [bookingId, qc, tripId],
  );

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
  const hasUnbooked = rows.some(
    (r) => r.kind === "pending" || r.kind === "failed",
  );

  // Bucket rows into ordered categories.
  const grouped = React.useMemo(() => {
    const buckets = new Map<CategoryKey, typeof rows>();
    for (const k of CATEGORY_ORDER) buckets.set(k, []);
    for (const r of rows) buckets.get(categoryFor(r.item.type))!.push(r);
    return CATEGORY_ORDER.filter(
      (k) => (buckets.get(k) ?? []).length > 0,
    ).map((k) => ({ key: k, items: buckets.get(k)! }));
  }, [rows]);

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      {/* Header — title + counter + progress + primary "Book all" CTA */}
      <header className="px-5 py-4 border-b border-border/60 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Booking status
          </p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {confirmed} of {total} confirmed
          </p>
        </div>
        <div className="h-px w-full bg-border overflow-hidden">
          <div
            className="h-full bg-foreground transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          {allDone
            ? "Everything's locked in. You're all set."
            : inFlight > 0
              ? "Pyltrix is booking your trip — watch each line confirm."
              : hasUnbooked
                ? "Hit Book all, or tap any single row to book just that one."
                : "Items will confirm here as the agent works."}
        </p>
        {hasUnbooked && (
          <button
            type="button"
            onClick={() => void bookAll()}
            disabled={bookingAll || bookingId !== null}
            className={cn(
              "w-full h-11 rounded-xl bg-foreground text-background text-sm font-semibold",
              "hover:bg-foreground/90 transition disabled:opacity-60 disabled:cursor-not-allowed",
              "inline-flex items-center justify-center gap-2",
            )}
          >
            {bookingAll ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Booking your trip…
              </>
            ) : (
              <>Book all</>
            )}
          </button>
        )}
      </header>

      {/* Grouped rows — collapsible categories so a 40-item trip reads
          as 5 sections of 5-10 things each instead of one overwhelming
          wall. Visible scrollbar on the outer scroll. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 space-y-1">
        {grouped.map(({ key, items: groupItems }) => {
          const groupConfirmed = groupItems.filter(
            (r) => r.kind === "confirmed",
          ).length;
          const meta = CATEGORY_META[key];
          // Default-collapse categories that are fully booked OR are
          // TRANSPORT (the plumbing); expand the rest so the customer
          // sees what still needs doing.
          const defaultOpen =
            !(groupConfirmed === groupItems.length) && key !== "TRANSPORT";
          return (
            <CategorySection
              key={key}
              label={meta.label}
              icon={meta.icon}
              total={groupItems.length}
              confirmed={groupConfirmed}
              defaultOpen={defaultOpen}
            >
              {groupItems.map(({ item, kind, code, amountCents }) => {
                const canBook =
                  AGENT_BOOKABLE.has(item.type) &&
                  (kind === "pending" || kind === "failed");
                const isThisBooking = bookingId === item.id;
                const rowInner = (
                  <>
                    <StatusBadge kind={isThisBooking ? "booking" : kind} />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "text-[13px] leading-snug truncate",
                          kind === "confirmed"
                            ? "font-medium text-foreground"
                            : "text-foreground/85",
                        )}
                      >
                        {item.title}
                      </p>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>
                          {isThisBooking
                            ? "Starting…"
                            : canBook
                              ? "Tap to book"
                              : statusLabel(kind)}
                        </span>
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
                  </>
                );
                return canBook ? (
                  <button
                    key={item.id}
                    type="button"
                    disabled={bookingId !== null}
                    onClick={() => void bookItem(item)}
                    className="w-full flex items-start gap-2.5 text-left rounded-lg px-2.5 py-2 hover:bg-surface-raised transition disabled:opacity-60"
                  >
                    {rowInner}
                  </button>
                ) : (
                  <div
                    key={item.id}
                    className="flex items-start gap-2.5 rounded-lg px-2.5 py-2"
                  >
                    {rowInner}
                  </div>
                );
              })}
            </CategorySection>
          );
        })}
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

/**
 * Collapsible category section. Header shows icon + label + "X of Y"
 * counter + a chevron that rotates when open. Click anywhere on the
 * header to toggle. Booked-out / TRANSPORT default to closed so the
 * panel reads tight; in-progress + pending categories default to open.
 */
function CategorySection({
  label,
  icon,
  total,
  confirmed,
  defaultOpen,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  total: number;
  confirmed: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/40 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/60 rounded-xl transition"
      >
        <span className="grid size-5 place-items-center text-foreground/70 shrink-0">
          {icon}
        </span>
        <p className="text-[12px] font-semibold tracking-tight flex-1 truncate">
          {label}
        </p>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {confirmed}/{total}
        </p>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="px-1 pb-1.5 pt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
  );
}
