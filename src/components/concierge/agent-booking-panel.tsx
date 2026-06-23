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
  BadgeCheck,
  Loader2,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  BookingConfirmDialog,
  confirmDetailFor,
} from "./booking-confirm-dialog";
import { SaveCardButton } from "./save-card-button";
import { isAgentBookable } from "@/lib/bookings/agent-scope";
import { ScreenshotProof } from "./screenshot-proof";
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
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Shared scope: hotels + golf always, and TRANSPORT only when it's a car
  // RENTAL (not an Uber/chauffeur transfer, which has its own deep-link). Using
  // the same predicate as the server route + status panel so the button never
  // shows for something the endpoint would reject — and cars now qualify.
  if (!isAgentBookable(item.type, item.title, item.description)) return null;

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
      setConfirmOpen(false);
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function approvePrice() {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripId}/items/${item.id}/approve-price`,
        { method: "POST" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error ?? "Couldn't approve — try again.");
        return;
      }
      toast.success("Approved — Pyltrix is completing the booking.");
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
    }, 6000);
    return () => clearInterval(id);
  }, [isInFlight, qc, tripId]);

  // --- State: no booking yet → primary CTA (review & confirm first) --------
  if (!booking) {
    return (
      <div className="space-y-1">
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={submitting}
          className="w-full h-12 rounded-2xl bg-accent text-accent-foreground hover:bg-accent/90 text-base font-semibold"
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
          You&apos;ll review the details before anything is booked.
        </p>
        <BookingConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          lines={[
            {
              title: item.title,
              detail: confirmDetailFor(item),
              costCents: item.cost,
            },
          ]}
          paymentNote={
            typeof item.cost === "number"
              ? "Paid securely by Pyltrix when the venue charges online; otherwise it settles at the property."
              : "Most venues like this settle at the property — nothing is charged up front."
          }
          busy={submitting}
          onConfirm={startBooking}
        />
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
    // Hybrid price-approval: the agent found the venue's REAL total above
    // the reviewed estimate and paused before paying. Show the real number
    // and a one-tap approve — on approval the agent re-runs with the gate
    // lifted and completes the booking.
    if (booking.failureReason === "price_approval" && booking.quotedPriceCents) {
      const quoted = Math.round(booking.quotedPriceCents / 100);
      const estimate = item.cost != null ? Math.round(item.cost / 100) : null;
      return (
        <div className="rounded-2xl border border-foreground/30 bg-foreground/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="size-9 rounded-xl bg-foreground/10 grid place-items-center text-foreground shrink-0">
              <ShieldCheck className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Found it — needs your OK on the price
              </p>
              <p className="text-xs text-foreground/80 mt-0.5">
                The venue&apos;s real total is{" "}
                <span className="font-semibold">${quoted.toLocaleString()}</span>
                {estimate != null
                  ? ` — above the $${estimate.toLocaleString()} estimate.`
                  : "."}{" "}
                Everything else is filled in and ready.
              </p>
            </div>
          </div>
          <Button
            onClick={approvePrice}
            disabled={submitting}
            className="w-full h-11 rounded-xl bg-accent text-accent-foreground hover:bg-accent/90 font-semibold"
          >
            {submitting ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : null}
            Approve &amp; book — ${quoted.toLocaleString()}
          </Button>
          <p className="text-[10px] text-muted-foreground text-center">
            Or swap this item for something else — nothing is booked until you
            approve.
          </p>
        </div>
      );
    }
    // Enquiry-only venue: we submitted the reservation REQUEST on the
    // customer's behalf — the venue confirms directly. Honest state with the
    // WHY spelled out; never dressed up as Booked.
    if (booking.failureReason === "enquiry_sent") {
      return (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <BadgeCheck className="size-4 text-accent" />
            <p className="text-sm font-semibold text-foreground">
              Request sent — venue confirms directly
            </p>
          </div>
          <p className="text-xs text-foreground/80 leading-relaxed">
            This venue doesn&apos;t take instant online bookings — they review
            requests personally. Pyltrix submitted your reservation request
            with your dates, party, and contact details; they&apos;ll confirm by
            email or phone, usually within a day.
          </p>
        </div>
      );
    }
    // The agent reached the PAYMENT step and stopped (no card on file yet).
    // Show the customer exactly what's queued — room/dates/price from the
    // agent's own summary — and a one-tap "save your card to finish" so the
    // review is something they can act on, not a dead-end "reviewing" card.
    const atPaymentStep =
      /payment|card (entry|number|step)|deposit due|ready to (pay|confirm)|at the card|filled in/i.test(
        booking.agentMessage ?? "",
      ) ||
      // The agent reached a real page and captured proof but its summary didn't
      // use a payment keyword — still a "we filled it in, here's the proof"
      // moment, not a dead-end. Treat a captured screenshot as review-able.
      (booking.screenshotUrl != null && booking.failureReason == null);
    const summary = (booking.agentMessage ?? "")
      .replace(/^.*?(at the |is at the )/i, "")
      .replace(/\s*[—-]\s*guest details.*$/i, "")
      .trim();
    if (atPaymentStep) {
      return (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="size-9 rounded-xl bg-accent/10 grid place-items-center text-accent shrink-0">
              <ShieldCheck className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Filled in &amp; ready to book
              </p>
              <p className="text-xs text-foreground/80 mt-0.5 leading-relaxed">
                {summary ||
                  "Pyltrix filled out the whole reservation and paused at the payment step."}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Save your card and Pyltrix completes the booking — you stay in
                control of the final charge.
              </p>
            </div>
          </div>
          {booking.screenshotUrl && (
            <ScreenshotProof
              url={booking.screenshotUrl}
              title={`Filled-in booking — ${item.title}`}
              caption="Tap to see what Pyltrix filled in"
            />
          )}
          <SaveCardButton returnTo={`/trips/${tripId}`} />
        </div>
      );
    }
    return (
      <div className="rounded-2xl border border-foreground/30 bg-foreground/5 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-foreground" />
          <p className="text-sm font-semibold text-foreground">
            Pyltrix concierge reviewing
          </p>
        </div>
        <p className="text-xs text-foreground/80">
          {summary ||
            "We're double-checking this booking before confirming it. You'll get an email the moment it's locked."}
        </p>
        {booking.screenshotUrl && (
          <ScreenshotProof
            url={booking.screenshotUrl}
            title={`Where Pyltrix got to — ${item.title}`}
            caption="Tap to see the page"
          />
        )}
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
      <div className="rounded-2xl border border-foreground/30 bg-foreground/5 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-xl bg-foreground/10 grid place-items-center text-foreground shrink-0">
            <ShieldCheck className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Booked ✓</p>
            <p className="text-xs text-foreground/80 mt-0.5">
              {code
                ? `Confirmation #${code}`
                : "Confirmed on the venue's site."}
              {amount != null ? ` · charged $${amount.toLocaleString()}` : ""}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
              Your confirmation is saved right here, and the venue has your
              reservation. Just bring your name to the door.
            </p>
          </div>
        </div>
        {booking.screenshotUrl && (
          <ScreenshotProof
            url={booking.screenshotUrl}
            title={`Venue confirmation — ${item.title}`}
            caption="Tap to see the venue's confirmation"
          />
        )}
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
    case "enquiry_sent":
      return "This venue is request-only — we submitted your reservation request and they'll confirm directly.";
    case "budget_exceeded":
      return "The real price came in over budget, so we didn't book it.";
    case "timeout":
      return "The booking ran past our time budget and we stopped to be safe.";
    case "ambiguous":
    default:
      return "We couldn't safely complete this booking automatically.";
  }
}
