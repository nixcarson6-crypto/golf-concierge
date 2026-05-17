"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import { ItineraryItemCard } from "./itinerary-item-card";
import type { DisplayItineraryItem } from "./itinerary-item-card";
import { cn } from "@/lib/utils";

/**
 * Group an itinerary into day buckets and render as a vertical timeline.
 * Items without a startTime fall under "Unscheduled" at the end.
 */
export function DayTimeline({
  items,
  onReorder,
  compact = false,
}: {
  items: DisplayItineraryItem[];
  onReorder?: (orderedIds: string[]) => void;
  compact?: boolean;
}) {
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = React.useState<string | null>(null);

  const grouped = React.useMemo(() => groupByDay(items), [items]);

  const handleDrop = (overId: string) => {
    if (!dragId || !onReorder) return;
    if (dragId === overId) return;
    const order = items.map((i) => i.id);
    const from = order.indexOf(dragId);
    const to = order.indexOf(overId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    onReorder(order);
    setDragId(null);
    setDropTargetId(null);
  };

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
              <div
                key={item.id}
                draggable={Boolean(onReorder)}
                onDragStart={(e) => {
                  if (!onReorder) return;
                  setDragId(item.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!onReorder || !dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropTargetId(item.id);
                }}
                onDragLeave={() => setDropTargetId(null)}
                onDrop={(e) => {
                  if (!onReorder) return;
                  e.preventDefault();
                  handleDrop(item.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTargetId(null);
                }}
                className={cn(
                  "relative group",
                  dragId === item.id && "opacity-50",
                  dropTargetId === item.id &&
                    dragId !== item.id &&
                    "ring-2 ring-[hsl(var(--navy))] rounded-2xl",
                )}
              >
                {onReorder && (
                  <span
                    aria-hidden
                    className="absolute -left-2 top-1/2 -translate-y-1/2 size-6 rounded-md bg-surface-raised/60 border border-border grid place-items-center text-muted-foreground opacity-0 group-hover:opacity-100 transition cursor-grab active:cursor-grabbing"
                  >
                    <GripVertical className="size-3.5" />
                  </span>
                )}
                <ItineraryItemCard item={item} compact={compact} />
              </div>
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
