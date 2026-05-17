"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function SelectDestinationButton({
  tripId,
  destinationId,
  selected,
}: {
  tripId: string;
  destinationId: string;
  selected: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const select = () => {
    start(async () => {
      const res = await fetch(
        `/api/trips/${tripId}/destinations/${destinationId}/select`,
        { method: "POST" },
      );
      if (!res.ok) {
        toast.error("Could not select destination");
        return;
      }
      toast.success("Destination selected — drafting itinerary…");
      router.push(`/trips/${tripId}`);
      router.refresh();
    });
  };

  if (selected) {
    return (
      <Button variant="emerald" size="sm" disabled>
        <Check className="size-4" /> Selected
      </Button>
    );
  }

  return (
    <Button variant="gold" size="sm" onClick={select} disabled={pending}>
      {pending ? "Selecting…" : (<>Select <ArrowRight className="size-4" /></>)}
    </Button>
  );
}
