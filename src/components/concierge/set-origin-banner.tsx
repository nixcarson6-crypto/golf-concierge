"use client";

/**
 * "Set your home airport" CTA shown on the result page when a trip has no
 * live Duffel flight offers yet — typically because the quiz didn't capture
 * an origin. One small inline form: type a city or airport, hit search,
 * Duffel runs server-side, the workspace query refetches, and the live
 * "Pick your flight" cards appear in place of this banner.
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2, Plane } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export function SetOriginBanner({ tripId }: { tripId: string }) {
  const qc = useQueryClient();
  const [origin, setOrigin] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = origin.trim();
    if (!trimmed) {
      toast.error("Type your home airport — city name or 3-letter code.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/refresh-flights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        offers?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        toast.error(data?.error ?? "Couldn't pull fares — try a different airport.");
        return;
      }
      toast.success(
        `Found ${data.offers ?? 0} business-class option${
          data.offers === 1 ? "" : "s"
        } — scroll up to pick one.`,
      );
      await qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-4 my-3 rounded-2xl border border-[hsl(var(--copper))]/30 bg-[hsl(var(--copper))]/8 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-[hsl(var(--copper))]/20 grid place-items-center text-[hsl(var(--copper))] shrink-0">
          <Plane className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[hsl(var(--copper))]">
            Set your home airport to see live fares
          </p>
          <p className="text-xs text-foreground/70 mt-0.5">
            We&apos;ll pull real Duffel business-class options for the dates
            and destinations on this trip.
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="e.g. DFW, JFK, or Dallas"
          autoFocus={false}
          className="flex-1 min-w-[180px] rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm focus:border-foreground focus:outline-none focus-visible:ring-0"
          disabled={busy}
        />
        <Button
          type="submit"
          disabled={busy}
          className="bg-[hsl(var(--copper))] text-white hover:bg-[hsl(var(--copper))]/90"
        >
          {busy ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              Searching…
            </>
          ) : (
            "Find flights"
          )}
        </Button>
      </form>
    </div>
  );
}
