"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ApproveItineraryButton({
  tripId,
  itineraryId,
}: {
  tripId: string;
  itineraryId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="navy"
      size="lg"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await fetch(
            `/api/trips/${tripId}/itinerary/${itineraryId}/approve`,
            { method: "POST" },
          );
          if (!res.ok) {
            toast.error("Could not approve itinerary");
            return;
          }
          toast.success("Approved — booking everything now.");
          router.refresh();
        })
      }
    >
      <Check className="size-4" /> {pending ? "Approving…" : "Approve & book"}
    </Button>
  );
}
