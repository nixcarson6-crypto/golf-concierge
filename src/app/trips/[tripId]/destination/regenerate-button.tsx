"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function RegenerateDestinationsButton({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await fetch(`/api/trips/${tripId}/destinations/regenerate`, {
            method: "POST",
          });
          if (!res.ok) {
            toast.error("Could not regenerate destinations");
            return;
          }
          toast.success("Refreshing destinations…");
          router.refresh();
        })
      }
    >
      <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      {pending ? "Refreshing…" : "Give me different options"}
    </Button>
  );
}
