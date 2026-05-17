"use client";

import * as React from "react";
import { ItineraryItemCard } from "./itinerary-item-card";
import type { DisplayItineraryItem } from "./itinerary-item-card";
import type { ItemAction } from "./item-actions-menu";

/**
 * Group an itinerary into day buckets and render as a vertical timeline.
 * Items without a startTime fall under "Unscheduled" at the end.
 */
export function DayTimeline({
  items,
  onAction,
  compact = false,
}: {
  items: DisplayItineraryItem[];
  onAction?: (itemId: string, a: ItemAction) => void;
  compact?: boolean;
}) {
  const grouped = React.useMemo(() => groupByDay(items), [items]);
  return (
    <div className="space-y-8">
      {grouped.map((bucket) => (
        <section key={bucket.key}>
          <header className="sticky top-[6.5rem] z-10 bg-background/85 backdrop-blur-md py-2 -mx-2 px-2 mb-3 border-b border-border/40">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {bucket.label}
            </p>
            <h3 className="text-display text-xl tracking-tight">
              {bucket.headline}
            </h3>
          </header>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {bucket.items.map((item) => (
              <ItineraryItemCard
                key={item.id}
                item={item}
                compact={compact}
                onAction={onAction ? (a) => onAction(item.id, a) : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function groupByDay(items: DisplayItineraryItem[]) {
  const buckets = new Map<
    string,
    { key: string; label: string; headline: string; dayIndex: number; items: DisplayItineraryItem[] }
  >();

  for (const item of items) {
    let key: string;
    let date: Date | null = null;
    if (item.startTime) {
      date = new Date(item.startTime);
      key = isoDay(date);
    } else {
      key = "_unscheduled";
    }
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label:
          key === "_unscheduled"
            ? "Anytime"
            : date!.toLocaleString("en-US", {
                weekday: "long",
              }),
        headline:
          key === "_unscheduled"
            ? "Unscheduled"
            : date!.toLocaleString("en-US", {
                month: "long",
                day: "numeric",
              }),
        dayIndex: key === "_unscheduled" ? 999 : date!.getTime(),
        items: [],
      });
    }
    buckets.get(key)!.items.push(item);
  }

  // Sort items inside each bucket by start time
  for (const b of buckets.values()) {
    b.items.sort((a, b) => {
      const t1 = a.startTime ? new Date(a.startTime).getTime() : Infinity;
      const t2 = b.startTime ? new Date(b.startTime).getTime() : Infinity;
      return t1 - t2;
    });
  }

  return Array.from(buckets.values()).sort((a, b) => a.dayIndex - b.dayIndex);
}

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
