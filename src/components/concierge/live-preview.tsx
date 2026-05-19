"use client";

import * as React from "react";
import {
  CalendarRange,
  CircleDollarSign,
  Compass,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import type {
  WorkspaceBooking,
  WorkspaceItinerary,
  WorkspaceTrip,
} from "./workspace";

export function LivePreview({
  tripId,
  trip,
  itinerary,
  bookings = [],
}: {
  tripId: string;
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
  bookings?: WorkspaceBooking[];
}) {
  // "Empty" = nothing the concierge has extracted yet. We surface a
  // gentler prompt instead of the static "Destination forming…" which
  // reads as if work is in progress when really we're waiting on input.
  const isEmpty =
    !trip.destination &&
    !trip.startDate &&
    !trip.groupSize &&
    !trip.budgetTotal &&
    !trip.budgetPerPerson &&
    !itinerary;

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Live trip
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h2 className="text-display text-xl tracking-tight truncate">
            {trip.destination ??
              (isEmpty ? "Waiting on details" : "Destination forming…")}
          </h2>
          {itinerary && (
            <Badge variant="navy" size="sm">
              v{itinerary.version}
            </Badge>
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <MetricChip
            icon={<CalendarRange className="size-3.5" />}
            label="Dates"
            value={
              trip.startDate
                ? formatDateRange(
                    new Date(trip.startDate),
                    trip.endDate ? new Date(trip.endDate) : null,
                  )
                : "TBD"
            }
          />
          <MetricChip
            icon={<Compass className="size-3.5" />}
            label="Group"
            value={trip.groupSize ? `${trip.groupSize} players` : "TBD"}
          />
          <MetricChip
            icon={<CircleDollarSign className="size-3.5" />}
            label="Per person"
            value={
              itinerary?.perPersonCost
                ? formatCurrency(itinerary.perPersonCost / 100)
                : trip.budgetPerPerson
                  ? formatCurrency(trip.budgetPerPerson / 100)
                  : "TBD"
            }
          />
        </div>
      </header>

      <ScrollArea className="flex-1">
        {!itinerary ? (
          <PreviewEmpty />
        ) : (
          <div className="px-5 py-5 space-y-3">
            {itinerary.aiSummary && (
              <div className="rounded-2xl border border-border/70 bg-surface-raised/50 px-4 py-3.5">
                <div className="flex items-start gap-2.5">
                  <Sparkles className="size-3.5 text-[hsl(var(--copper))] mt-0.5 shrink-0" />
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {itinerary.aiSummary}
                  </p>
                </div>
              </div>
            )}
            {itinerary.changes && itinerary.changes.length > 0 && (
              <div className="rounded-2xl border border-[hsl(var(--navy)/0.2)] bg-[hsl(var(--navy)/0.04)] px-4 py-3 text-xs space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-[hsl(var(--navy))]">
                  What changed in v{itinerary.version}
                </p>
                {itinerary.changes.map((c, i) => (
                  <p key={i} className="text-muted-foreground leading-relaxed">
                    · {c}
                  </p>
                ))}
              </div>
            )}
            {itinerary.items.map((item) => (
              <ItineraryItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </ScrollArea>
      <CartFooter tripId={tripId} bookings={bookings} />
    </div>
  );
}

function CartFooter({
  tripId,
  bookings,
}: {
  tripId: string;
  bookings: WorkspaceBooking[];
}) {
  const [submitting, setSubmitting] = React.useState(false);

  const unpaid = bookings.filter((b) => !b.paidAt && (b.cost ?? 0) > 0);
  const total = unpaid.reduce((sum, b) => sum + (b.cost ?? 0), 0);

  if (unpaid.length === 0) return null;

  const onPay = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/checkout/cart`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error ?? "Couldn't start checkout.");
        return;
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Checkout request failed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-surface/80 backdrop-blur-xl px-5 py-3 space-y-2.5">
      <div className="space-y-1">
        {unpaid.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="truncate text-muted-foreground">
              {b.title}
              {b.isStub && (
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[hsl(var(--copper))]">
                  pencilled
                </span>
              )}
            </span>
            <span className="num-tabular shrink-0">
              {b.cost ? formatCurrency(b.cost / 100) : "—"}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/40">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Total
          </p>
          <p className="text-display text-lg num-tabular">
            {formatCurrency(total / 100)}
          </p>
        </div>
        <Button
          variant="navy"
          size="sm"
          onClick={onPay}
          disabled={submitting}
          className="shrink-0"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Starting…
            </>
          ) : (
            <>Pay {formatCurrency(total / 100)}</>
          )}
        </Button>
      </div>
    </div>
  );
}

function MetricChip({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface-raised/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 num-tabular text-sm truncate">{value}</p>
    </div>
  );
}

function PreviewEmpty() {
  return (
    <div className="h-full grid place-items-center px-8 py-16 text-center">
      <div>
        <div className="mx-auto size-12 rounded-2xl border border-[hsl(var(--copper)/0.3)] bg-[hsl(var(--copper)/0.06)] grid place-items-center text-[hsl(var(--copper))]">
          <Sparkles className="size-5" />
        </div>
        <p className="mt-5 text-display text-lg tracking-tight">
          Your trip will take shape here.
        </p>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
          Tell the concierge a destination, dates, group size, and budget — this
          panel fills in as you go.
        </p>
      </div>
    </div>
  );
}
