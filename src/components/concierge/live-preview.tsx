"use client";

import * as React from "react";
import {
  CalendarRange,
  CircleDollarSign,
  Compass,
  Sparkles,
  ArrowRight,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import type {
  WorkspaceItinerary,
  WorkspaceMe,
  WorkspaceTrip,
} from "./workspace";
import type { ItemAction } from "@/components/itinerary/item-actions-menu";

export function LivePreview({
  tripId,
  trip,
  itinerary,
  me,
  approval,
  onItemAction,
}: {
  tripId: string;
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
  me: WorkspaceMe;
  approval: { approved: number; total: number; quorum: number };
  onItemAction: (args: { itemId: string; body: ItemAction }) => void;
}) {
  const qc = useQueryClient();
  const itineraryIsDraft = itinerary?.status === "CURRENT";

  const recordApproval = async (decision: "APPROVED" | "DECLINED") => {
    if (!itinerary) return;
    const res = await fetch(`/api/trips/${tripId}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, itineraryId: itinerary.id }),
    });
    if (!res.ok) {
      toast.error("Could not record your decision");
      return;
    }
    toast.success(
      decision === "APPROVED"
        ? "You approved. Group quorum will trigger booking."
        : "Declined — concierge will revise.",
    );
    qc.invalidateQueries({ queryKey: ["workspace", tripId] });
  };

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
            {itinerary.changes && itinerary.changes.length > 0 && (
              <div className="rounded-2xl border border-[hsl(var(--gold)/0.3)] bg-[hsl(var(--gold)/0.05)] px-4 py-3 text-xs space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-[hsl(var(--gold))]">
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
              <ItineraryItemCard
                key={item.id}
                item={item}
                onAction={(action) =>
                  onItemAction({ itemId: item.id, body: action })
                }
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {itinerary && itineraryIsDraft && (
        <footer className="p-3 border-t border-border/60 bg-surface/40 space-y-2">
          {approval.total > 1 && (
            <div className="flex items-center justify-between text-xs px-1">
              <span className="text-muted-foreground">
                Group approval · {approval.approved}/{approval.total}
                {approval.quorum < approval.total &&
                  ` (need ${approval.quorum})`}
              </span>
              <span className="num-tabular text-muted-foreground">
                {itinerary.totalCost
                  ? `Total ${formatCurrency(itinerary.totalCost / 100)}`
                  : null}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            {me.role === "OWNER" && (
              <Button
                variant="gold"
                size="sm"
                onClick={() => recordApproval("APPROVED")}
                className="flex-1"
              >
                <Check className="size-4" />
                {approval.total > 1 ? "Approve as owner" : "Approve & book"}
                <ArrowRight className="size-4" />
              </Button>
            )}
            {me.role !== "OWNER" && me.myApproval !== "APPROVED" && (
              <>
                <Button
                  variant="gold"
                  size="sm"
                  onClick={() => recordApproval("APPROVED")}
                  className="flex-1"
                >
                  <Check className="size-4" /> I approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => recordApproval("DECLINED")}
                >
                  <X className="size-4" /> Decline
                </Button>
              </>
            )}
            {me.role !== "OWNER" && me.myApproval === "APPROVED" && (
              <Badge variant="emerald" size="sm" className="px-3 py-1.5">
                <Check className="size-3" /> You approved — waiting on the group
              </Badge>
            )}
          </div>
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
