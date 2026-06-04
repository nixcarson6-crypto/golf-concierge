"use client";

/**
 * The agent-booking control inside ItineraryItemDialog.
 *
 * Renders ONE of five states based on the item's Booking row in the workspace
 * snapshot — so the same panel covers "Book it for me" → live progress →
 * either a Booked ✓ reassurance card or an honest failure fallback. The data
 * comes from the workspace SSE refetch (driven by the internal nudge bridge
 * during the agent run), so no extra polling is needed here.
 *
 * State machine:
 *   no booking          → primary CTA "Book it for me"
 *   SEARCHING/PENDING   → spinner + live progress line ("Filling form…")
 *   HELD                → "Holding — finalising"
 *   NEEDS_REVIEW        → "Pyltrix concierge reviewing" (manual drain)
 *   CONFIRMED           → reassurance: confirmation #, $ charged, "Venue is
 *                         emailing you", thumbnail screenshot
 *   FAILED              → failure copy + the existing website/phone buttons
 */

import * as React from "react";
import { toast } from "sonner";
import {
  Loader2,
  ShieldCheck,
  AlertTriangle,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { WorkspaceItemBooking, WorkspaceItineraryItem } from "./workspace";

type Props = {
  tripId: string;
  item: WorkspaceItineraryItem;
  /** Fallback Places contact when the booking hasn't recorded its own yet. */
  fallback?: { website: string | null; phone: string | null };
};

const IN_PROGRESS_STATUSES: WorkspaceItemBooking["status"][] = [
  "PENDING",
  "SEARCHING",
  "HELD",
];

export function AgentBookingPanel({ tripId, item, fallback }: Props) {
  const booking = item.booking ?? null;
  const qc = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);
  const [screenshotOpen, setScreenshotOpen] = React.useState(false);

  // Booking-eligible item types. FLIGHT goes through Duffel; FREE_TIME isn't
  // bookable; TRANSPORT has the Uber deep-link already.
  const eligible =
    item.type !== "FLIGHT" &&
    item.type !== "FREE_TIME" &&
    item.type !== "TRANSPORT";
  if (!eligible) return null;

  async function startBooking() {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripId}/items/${item.id}/book-agent`,
        { method: "POST" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Couldn't queue the booking — try again.");
        return;
      }
      toast.success("Pyltrix is on it — watch this card for live updates.");
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Poll for status updates whenever a booking is mid-flight. The SSE
  // nudge bridge SHOULD push updates the moment the agent's progress
  // changes — but it requires INTERNAL_NUDGE_SECRET to be set AND the
  // /api/internal/nudge route to be reachable. If either's off, the
  // booking row keeps moving on the server but the panel sits there
  // forever showing 'Pyltrix is booking this…'. A 3s polling refetch
  // makes the panel honest even when the nudge bridge isn't wired,
  // and is cheap (workspace endpoint is one query).
  const isInFlight =
    booking != null && IN_PROGRESS_STATUSES.includes(booking.status);
  React.useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    }, 3000);
    return () => clearInterval(id);
  }, [isInFlight, qc, tripId]);

  // --- State: no booking yet → primary CTA ---------------------------------
  if (!booking) {
    return (
      <div className="space-y-1">
        <Button
          onClick={startBooking}
          disabled={submitting}
          className="w-full h-12 rounded-2xl bg-foreground text-background hover:bg-foreground/90 text-base font-semibold"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 mr-2 animate-spin" />
              Queueing…
            </>
          ) : (
            <>Book it for me</>
          )}
        </Button>
        <p className="text-[10px] text-muted-foreground text-center">
          Pyltrix concierge will reserve this for you. You&apos;ll see live
          progress.
        </p>
      </div>
    );
  }

  // --- State: in progress --------------------------------------------------
  if (IN_PROGRESS_STATUSES.includes(booking.status)) {
    const progress =
      booking.agentProgress ?? defaultProgressLabel(booking.status);
    return (
      <div className="rounded-2xl border border-foreground/30 bg-foreground/5 px-4 py-3 flex items-center gap-3">
        <Loader2 className="size-5 text-foreground animate-spin shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Pyltrix is booking this…
          </p>
          <p className="text-xs text-foreground/70 truncate">{progress}</p>
        </div>
      </div>
    );
  }

  // --- State: NEEDS_REVIEW -------------------------------------------------
  if (booking.status === "NEEDS_REVIEW") {
    return (
      <div className="rounded-2xl border border-foreground/30 bg-foreground/5 px-4 py-3 space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-foreground" />
          <p className="text-sm font-semibold text-foreground">
            Pyltrix concierge reviewing
          </p>
        </div>
        <p className="text-xs text-foreground/80">
          We&apos;re double-checking this booking before confirming it. You&apos;ll
          get an email the moment it&apos;s locked.
        </p>
      </div>
    );
  }

  // --- State: CONFIRMED → the reassurance card -----------------------------
  if (booking.status === "CONFIRMED") {
    const code = booking.confirmationCode?.trim() || null;
    const amount =
      typeof booking.amountChargedCents === "number"
        ? Math.round(booking.amountChargedCents / 100)
        : null;
    return (
      <>
        <div className="rounded-2xl border border-foreground/30 bg-foreground/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="size-9 rounded-xl bg-foreground/10 grid place-items-center text-foreground shrink-0">
              <ShieldCheck className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Booked ✓
              </p>
              <p className="text-xs text-foreground/80 mt-0.5">
                {code
                  ? `Confirmation #${code}`
                  : "Confirmed on the venue's site."}
                {amount != null ? ` · charged $${amount.toLocaleString()}` : ""}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                The venue is emailing you a confirmation directly. Bring your
                name to the door — they have your reservation.
              </p>
            </div>
          </div>
          {booking.screenshotUrl && (
            <button
              type="button"
              onClick={() => setScreenshotOpen(true)}
              className="w-full rounded-xl overflow-hidden border border-foreground/30 hover:border-foreground/60 transition relative group"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={booking.screenshotUrl}
                alt="Venue confirmation page"
                className="w-full h-auto object-cover max-h-44"
              />
              <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] uppercase tracking-widest text-center py-1.5">
                Tap to see the venue&apos;s confirmation
              </div>
            </button>
          )}
        </div>
        {booking.screenshotUrl && (
          <Dialog open={screenshotOpen} onOpenChange={setScreenshotOpen}>
            <DialogContent className="max-w-4xl p-0 overflow-hidden">
              <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between gap-3">
                <DialogTitle className="text-sm font-semibold">
                  Venue confirmation — {item.title}
                </DialogTitle>
                <button
                  type="button"
                  onClick={() => setScreenshotOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="bg-black grid place-items-center max-h-[80vh] overflow-auto">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={booking.screenshotUrl}
                  alt="Venue confirmation page (full)"
                  className="w-full h-auto"
                />
              </div>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }

  // --- State: OpenTable / Resy clickout ------------------------------------
  // Not a failure — it's the intended path for these venues. One-tap link
  // to the reservation page (pre-filled where the platform supports it).
  if (booking.clickout?.url) {
    const label = booking.clickout.label ?? "the reservation site";
    return (
      <div className="space-y-1">
        <a
          href={booking.clickout.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full h-12 rounded-2xl bg-foreground text-background hover:bg-foreground/90 text-base font-semibold inline-flex items-center justify-center"
        >
          Reserve on {label}
        </a>
        <p className="text-[10px] text-muted-foreground text-center">
          {label} handles this venue&apos;s reservations — one tap, your
          details carry over. Everything else on the trip, Pyltrix books for
          you.
        </p>
      </div>
    );
  }

  // --- State: FAILED (or CANCELLED) → honest fallback ----------------------
  const fallbackWebsite =
    booking.fallbackContact?.website ?? fallback?.website ?? booking.vendorUrl;
  const fallbackPhone =
    booking.fallbackContact?.phone ?? fallback?.phone ?? null;

  return (
    <div className="rounded-2xl border border-foreground/30 bg-foreground/5 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-foreground shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            We couldn&apos;t auto-book this one
          </p>
          <p className="text-xs text-foreground/80 mt-0.5">
            {friendlyFailureCopy(booking.failureReason)} You can finish it
            directly below.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {fallbackWebsite && (
          <a
            href={fallbackWebsite}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 rounded-xl bg-foreground text-background text-xs font-semibold px-3 py-2 hover:bg-foreground/90"
          >
            Visit website
          </a>
        )}
        {fallbackPhone && (
          <a
            href={`tel:${fallbackPhone.replace(/[^+\d]/g, "")}`}
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 rounded-xl border border-foreground/40 bg-foreground/5 text-foreground text-xs font-semibold px-3 py-2 hover:bg-foreground/10"
          >
            Call {fallbackPhone}
          </a>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={startBooking}
          disabled={submitting}
          className="shrink-0"
        >
          {submitting ? <Loader2 className="size-3 mr-1.5 animate-spin" /> : null}
          Try again
        </Button>
      </div>
    </div>
  );
}

function defaultProgressLabel(status: WorkspaceItemBooking["status"]): string {
  switch (status) {
    case "PENDING":
      return "Queued…";
    case "SEARCHING":
      return "Opening venue site…";
    case "HELD":
      return "Holding the reservation…";
    default:
      return "Working…";
  }
}

function friendlyFailureCopy(code: string | null): string {
  switch (code) {
    case "no_availability":
      return "The venue didn't have your requested time.";
    case "declined_card":
      return "The venue's checkout wouldn't accept our payment card.";
    case "captcha_blocked":
      return "This site has a security check we couldn't clear automatically.";
    case "login_required":
      return "This site needs an account login we don't have.";
    case "form_not_found":
      return "We couldn't find an online booking form — they likely take reservations by phone.";
    case "budget_exceeded":
      return "The real price came in over budget, so we didn't book it.";
    case "timeout":
      return "The booking ran past our time budget and we stopped to be safe.";
    case "ambiguous":
    default:
      return "We couldn't safely complete this booking automatically.";
  }
}
