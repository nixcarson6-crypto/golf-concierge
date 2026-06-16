"use client";

/**
 * "Mark booked" control for a concierge-queue item. Operator books on the
 * venue's site, drops in the confirmation number here, and the booking flips
 * to CONFIRMED for the customer.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ResolveButton({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/queue/${bookingId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationCode: code.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Couldn't mark it booked.");
        return;
      }
      toast.success("Marked booked — customer now sees it confirmed.");
      router.refresh();
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        size="sm"
        className="bg-accent text-accent-foreground hover:bg-accent/90"
        onClick={() => setOpen(true)}
      >
        <Check className="size-4 mr-1.5" /> Mark booked
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Confirmation #"
        className="w-36 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs focus:border-foreground focus:outline-none"
        disabled={busy}
      />
      <Button
        size="sm"
        className="bg-accent text-accent-foreground hover:bg-accent/90"
        onClick={submit}
        disabled={busy}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : "Confirm"}
      </Button>
    </div>
  );
}
