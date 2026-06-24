"use client";

/**
 * Billing settings — the customer's saved card.
 *
 * Shows which card the agent will use to book ("Visa •••• 4242, exp 4/27"),
 * and lets them REPLACE it (add a new card → it becomes the default, the old
 * one is detached) or REMOVE it. This is the menu Carson asked for: a repeat
 * customer who wants a different card on a later trip can change it here, so
 * the agent never silently books on the wrong card.
 *
 * The "add/replace" button reuses the same Stripe Checkout setup flow as the
 * trip page; on return we confirm + refresh the card shown here (the webhook
 * also records it in production — both are idempotent).
 */

import * as React from "react";
import { toast } from "sonner";
import { CreditCard, Loader2, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { SaveCardButton } from "@/components/concierge/save-card-button";
import type { SavedCard } from "@/lib/payments/saved-card";

export function BillingSection({
  initialCard,
  stripeEnabled,
}: {
  initialCard: SavedCard | null;
  stripeEnabled: boolean;
}) {
  const [card, setCard] = React.useState<SavedCard | null>(initialCard);
  const [removing, setRemoving] = React.useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const handled = React.useRef<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/me/payment-method");
      if (!res.ok) return;
      const data = (await res.json()) as { card?: SavedCard | null };
      setCard(data.card ?? null);
    } catch {
      /* keep what we have */
    }
  }, []);

  // Confirm a card saved via Stripe Checkout when the customer returns here
  // (?card_saved=<sessionId>) — the webhook can't reach localhost, and even in
  // prod this is instant. Then refresh the displayed card + strip the param.
  React.useEffect(() => {
    const sessionId = searchParams?.get("card_saved");
    if (!sessionId || handled.current === sessionId) return;
    handled.current = sessionId;
    const url = new URL(window.location.href);
    url.searchParams.delete("card_saved");
    router.replace(url.pathname + url.search);
    void (async () => {
      try {
        await fetch("/api/me/payment-method/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch {
        /* the GET refresh below still reflects whatever saved */
      }
      await refresh();
      toast.success("Card updated.");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const remove = React.useCallback(async () => {
    if (removing) return;
    if (!window.confirm("Remove this card? You'll need to add one again to book.")) {
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch("/api/me/payment-method", { method: "DELETE" });
      if (!res.ok) {
        toast.error("Couldn't remove the card — try again.");
        return;
      }
      setCard(null);
      toast.success("Card removed.");
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setRemoving(false);
    }
  }, [removing]);

  return (
    <section className="glass rounded-2xl p-6">
      <h2 className="text-sm font-medium">Payment method</h2>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
        The card we use to book your trips. Update it any time — the agent
        always uses the card shown here.
      </p>

      {!stripeEnabled ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Payments aren&apos;t enabled yet.
        </p>
      ) : card ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <CreditCard className="size-5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {formatBrand(card.brand)} •••• {card.last4}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  Expires {card.expMonth}/{card.expYear}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={removing}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:opacity-80 transition disabled:opacity-50 shrink-0"
            >
              {removing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </button>
          </div>
          <SaveCardButton returnTo="/settings" label="Replace card" />
        </div>
      ) : (
        <div className="mt-4">
          <SaveCardButton returnTo="/settings" label="Add a card" />
        </div>
      )}
    </section>
  );
}

function formatBrand(brand: string): string {
  const map: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    diners: "Diners Club",
    jcb: "JCB",
    unionpay: "UnionPay",
  };
  return map[brand?.toLowerCase()] ?? brand.replace(/\b\w/g, (c) => c.toUpperCase());
}
