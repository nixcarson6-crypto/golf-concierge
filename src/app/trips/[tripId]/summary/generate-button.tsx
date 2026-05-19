"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GenerateSummaryButton({
  tripId,
  hasSummary,
}: {
  tripId: string;
  hasSummary: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant={hasSummary ? "outline" : "navy"}
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await fetch(`/api/trips/${tripId}/summary/generate`, {
            method: "POST",
          });
          if (!res.ok) {
            toast.error("Could not generate summary");
            return;
          }
          toast.success("Summary generated.");
          router.refresh();
        })
      }
    >
      <Sparkles className="size-4" />
      {pending ? "Generating…" : hasSummary ? "Regenerate" : "Generate summary"}
    </Button>
  );
}
