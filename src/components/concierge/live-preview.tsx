"use client";

import Link from "next/link";
import {
  CalendarRange,
  CircleDollarSign,
  Compass,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import type { WorkspaceItinerary, WorkspaceTrip } from "./workspace";

export function LivePreview({
  tripId,
  trip,
  itinerary,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
}) {
  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Live trip
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h2 className="text-display text-xl tracking-tight truncate">
            {trip.destination ?? "Destination forming…"}
          </h2>
          {itinerary && (
            <Badge variant="gold" size="sm">
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
                  <Sparkles className="size-3.5 text-[hsl(var(--gold))] mt-0.5 shrink-0" />
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {itinerary.aiSummary}
                  </p>
                </div>
              </div>
            )}
            {itinerary.items.map((item) => (
              <ItineraryItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </ScrollArea>

      {itinerary && itinerary.status === "CURRENT" && (
        <footer className="p-3 border-t border-border/60 bg-surface/40 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {itinerary.totalCost
              ? `Total ${formatCurrency(itinerary.totalCost / 100)}`
              : "Estimating cost…"}
          </p>
          <Button asChild variant="gold" size="sm">
            <Link href={`/trips/${tripId}/itinerary`}>
              Review & approve <ArrowRight />
            </Link>
          </Button>
        </footer>
      )}
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
        <div className="mx-auto size-12 rounded-2xl border border-[hsl(var(--gold)/0.3)] bg-[hsl(var(--gold)/0.08)] grid place-items-center text-[hsl(var(--gold))]">
          <Sparkles className="size-5" />
        </div>
        <p className="mt-5 text-display text-lg tracking-tight">
          Your itinerary will appear here.
        </p>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
          Tell the concierge what you want and watch the plan build in real time.
        </p>
      </div>
    </div>
  );
}
