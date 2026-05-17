"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { DayTimeline } from "@/components/itinerary/day-timeline";
import type { DisplayItineraryItem } from "@/components/itinerary/itinerary-item-card";
import type { ItemAction } from "@/components/itinerary/item-actions-menu";

/**
 * Client wrapper around the itinerary so users can lock/swap/upgrade items
 * with no navigation — same actions as in the command-center preview, full
 * page width.
 */
export function ItineraryView({
  tripId,
  items,
  readOnly,
}: {
  tripId: string;
  items: DisplayItineraryItem[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

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

  return (
    <div className="mt-8">
      <DayTimeline
        items={items}
        onAction={readOnly || pending ? undefined : apply}
      />
    </div>
  );
}
