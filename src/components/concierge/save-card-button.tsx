"use client";

/**
 * "Save your card" — one tap → Stripe-hosted card collection (Checkout in
 * setup mode). We never touch the raw card number; Stripe vaults it and the
 * webhook records it as the customer's default payment method. Once saved,
 * the booking agent can complete paid bookings (hotels/golf/cars)
 * end-to-end instead of stopping at the payment step.
 *
 * No frontend Stripe SDK needed — we just redirect to the hosted URL.
 */

import * as React from "react";
import { toast } from "sonner";
import { CreditCard, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function SaveCardButton({
  returnTo,
  className,
}: {
  /** Same-origin path to return to after saving (e.g. the current trip). */
  returnTo?: string;
  className?: string;
}) {
  const [loading, setLoading] = React.useState(false);

  const start = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/me/payment-method/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          returnTo:
            returnTo ??
            (typeof window !== "undefined"
              ? window.location.pathname
              : "/dashboard"),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.url) {
        toast.error(data?.error ?? "Couldn't start card setup — try again.");
        setLoading(false);
        return;
      }
      // Hand off to Stripe's hosted, PCI-compliant card page.
      window.location.href = data.url;
    } catch {
      toast.error("Network error — try again.");
      setLoading(false);
    }
  }, [returnTo]);

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={loading}
      className={cn(
        "w-full h-10 rounded-xl border border-border bg-background text-sm font-medium",
        "hover:bg-surface-raised transition disabled:opacity-60 disabled:cursor-not-allowed",
        "inline-flex items-center justify-center gap-2",
        className,
      )}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <CreditCard className="size-4" />
      )}
      Save your card for one-tap booking
    </button>
  );
}
