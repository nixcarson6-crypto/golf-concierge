"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CreatePaymentLinksButton({
  tripId,
  disabled,
  reason,
}: {
  tripId: string;
  disabled: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-2">
      {reason && (
        <span className="text-[11px] text-muted-foreground">{reason}</span>
      )}
      <Button
        variant="gold"
        size="sm"
        disabled={disabled || pending}
        onClick={() =>
          start(async () => {
            const res = await fetch(`/api/trips/${tripId}/payments/payment-link`, {
              method: "POST",
            });
            if (!res.ok) {
              toast.error("Could not create payment links");
              return;
            }
            toast.success("Per-person links created.");
            router.refresh();
          })
        }
      >
        <CreditCard className="size-4" /> {pending ? "Creating…" : "Create payment links"}
      </Button>
    </div>
  );
}
