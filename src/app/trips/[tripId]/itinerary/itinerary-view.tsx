"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DayTimeline } from "@/components/itinerary/day-timeline";
import type { DisplayItineraryItem } from "@/components/itinerary/itinerary-item-card";

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
  const [, start] = useTransition();
  const [items, setItems] = useState<DisplayItineraryItem[]>(initial);

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
        onReorder={readOnly ? undefined : handleReorder}
      />
    </div>
  );
}
