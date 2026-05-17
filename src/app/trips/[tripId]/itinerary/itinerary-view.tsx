"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DayTimeline } from "@/components/itinerary/day-timeline";
import type { DisplayItineraryItem } from "@/components/itinerary/itinerary-item-card";
import type { ItemAction } from "@/components/itinerary/item-actions-menu";

export function ItineraryView({
  tripId,
  itineraryId,
  items: initial,
  readOnly,
}: {
  tripId: string;
  itineraryId: string;
  items: DisplayItineraryItem[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Optimistic local state so drag-drop feels instant.
  const [items, setItems] = useState<DisplayItineraryItem[]>(initial);

  const apply = (itemId: string, body: ItemAction) =>
    start(async () => {
      const res = await fetch(
        `/api/trips/${tripId}/itinerary-items/${itemId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        toast.error("Couldn't apply that change");
        return;
      }
      const verb =
        body.action === "lock"
          ? body.locked
            ? "Locked"
            : "Unlocked"
          : body.action === "swap"
            ? "Swapped"
            : body.action === "upgrade"
              ? "Upgraded"
              : body.action === "downgrade"
                ? "Found a value option"
                : "Regenerated";
      toast.success(verb);
      router.refresh();
    });

  const handleReorder = (orderedIds: string[]) => {
    setItems(
      orderedIds
        .map((id) => items.find((i) => i.id === id))
        .filter((i): i is DisplayItineraryItem => Boolean(i)),
    );
    start(async () => {
      const res = await fetch(`/api/trips/${tripId}/itinerary-items/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itineraryId, itemIds: orderedIds }),
      });
      if (!res.ok) {
        toast.error("Could not save the new order");
        setItems(initial);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="mt-8">
      <DayTimeline
        items={items}
        onAction={readOnly || pending ? undefined : apply}
        onReorder={readOnly ? undefined : handleReorder}
      />
    </div>
  );
}
