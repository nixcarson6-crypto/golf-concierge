"use client";

import * as React from "react";
import { useTransition } from "react";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

/**
 * Single-button "pay my share" for the calling member. Opens a Stripe
 * checkout session as either a FULL share or a 25%-of-total DEPOSIT.
 */
export function PayMyShareButton({
  tripId,
  depositCents,
  fullCents,
}: {
  tripId: string;
  depositCents: number;
  fullCents: number;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = React.useState(false);

  const pay = (paymentType: "FULL" | "DEPOSIT") =>
    start(async () => {
      const res = await fetch(`/api/trips/${tripId}/payments/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentType }),
      });
      if (!res.ok) {
        toast.error("Could not open checkout.");
        return;
      }
      const { url } = await res.json();
      if (url) window.location.href = url;
    });

  if (!open) {
    return (
      <Button variant="navy" size="md" onClick={() => setOpen(true)}>
        <CreditCard className="size-4" /> Pay my share
      </Button>
    );
  }
  return (
    <div className="glass-strong rounded-2xl p-3 flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || depositCents === 0}
        onClick={() => pay("DEPOSIT")}
      >
        Deposit · {formatCurrency(depositCents / 100)}
      </Button>
      <Button variant="navy" size="sm" disabled={pending} onClick={() => pay("FULL")}>
        Full · {formatCurrency(fullCents / 100)}
      </Button>
    </div>
  );
}
