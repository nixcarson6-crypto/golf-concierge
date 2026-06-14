"use client";

/**
 * The booking-status side panel.
 *
 * A tall, glanceable checklist that sits beside the itinerary on the
 * result page. Every bookable item shows its live state — Booked ✓ with
 * confirmation number + amount, Booking… (agent working), Reviewing,
 * Needs you, or Not booked yet. A "X of Y confirmed" header + thin
 * progress bar gives the customer the one thing autonomous booking has
 * to earn: the feeling that it actually happened.
 *
 * Derives entirely from itinerary.items[].booking — no extra fetch.
 * Updates live as the workspace snapshot refetches (SSE + the agent
 * panel's 3s poll).
 */

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Loader2,
  Circle,
  AlertCircle,
  ShieldCheck,
  Plane,
  BedDouble,
  Flag,
  UtensilsCrossed,
  Wine,
  Car,
  Flower2,
  Sparkles,
  PartyPopper,
  ChevronDown,
  Phone,
  Globe,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BookingConfirmDialog,
  confirmDetailFor,
} from "./booking-confirm-dialog";
import type {
  WorkspaceItinerary,
  WorkspaceItineraryItem,
} from "./workspace";

// What the browser agent books — hotels, golf, and car rentals — lives
// in one shared module (isAgentBookable) so the panel and the server
// route never drift. Flights go through "Book all" (Duffel); per-ride
// Uber/chauffeur transfers aren't browser-bookable, so only car RENTALS
// among transport items are tap-to-book.
import { isAgentBookable } from "@/lib/bookings/agent-scope";
import { SaveCardButton } from "./save-card-button";
import { ScreenshotProof } from "./screenshot-proof";

// Types we present as contact-and-book-yourself suggestions, never
// auto-booked. Each surfaces Call / Visit-site actions. (Carson's call:
// "forget booking restaurants — give them the suggestion with the number.")
const SUGGESTION_TYPES = new Set(["DINING", "NIGHTLIFE", "SPA", "ACTIVITY"]);

type RowStatus = "confirmed" | "booking" | "review" | "failed" | "pending";

function statusFor(item: WorkspaceItineraryItem): {
  kind: RowStatus;
  code: string | null;
  amountCents: number | null;
  /** Venue phone to call when the agent couldn't book online (e.g. a
   *  phone-only restaurant). Sourced from Google Places at booking time. */
  phone: string | null;
  /** Venue website fallback. */
  website: string | null;
  /** Venue reservation email (for email-only venues — agent-captured). */
  email: string | null;
  /** Why the booking failed — drives the "Call to book" vs "Needs you" copy. */
  failureReason: string | null;
  /** Agent-captured screenshot of the page it reached (filled-in form or the
   *  venue's confirmation) — the customer's tap-to-enlarge proof. */
  screenshotUrl: string | null;
  /** The agent's free-text summary of what it reached ("Junior Suite — $6,570
   *  at the card step"). Drives the review copy. */
  agentMessage: string | null;
  /** Real venue total the agent read when it paused for price approval. */
  quotedPriceCents: number | null;
} {
  const b = item.booking ?? null;
  // Prefer an agent-captured fallback contact, then fall back to the
  // build-time Places contact stored on the item (suggestion venues that
  // never run the agent only have the latter).
  const phone = b?.fallbackContact?.phone ?? item.contact?.phone ?? null;
  const website = b?.fallbackContact?.website ?? item.contact?.website ?? null;
  const email = b?.fallbackContact?.email ?? null;
  if (!b)
    return {
      kind: "pending",
      code: null,
      amountCents: null,
      phone,
      website,
      email,
      failureReason: null,
      screenshotUrl: null,
      agentMessage: null,
      quotedPriceCents: null,
    };
  const base = {
    phone,
    website,
    email,
    failureReason: b.failureReason ?? null,
    screenshotUrl: b.screenshotUrl ?? null,
    agentMessage: b.agentMessage ?? null,
    quotedPriceCents: b.quotedPriceCents ?? null,
  };
  switch (b.status) {
    case "CONFIRMED":
      return {
        kind: "confirmed",
        code: b.confirmationCode ?? null,
        amountCents: b.amountChargedCents ?? item.cost ?? null,
        ...base,
      };
    case "SEARCHING":
    case "PENDING":
    case "HELD":
      return { kind: "booking", code: null, amountCents: null, ...base };
    case "NEEDS_REVIEW":
      return { kind: "review", code: null, amountCents: null, ...base };
    case "FAILED":
    case "CANCELLED":
      return { kind: "failed", code: null, amountCents: null, ...base };
    default:
      return { kind: "pending", code: null, amountCents: null, ...base };
  }
}

function TypeIcon({ type }: { type: WorkspaceItineraryItem["type"] }) {
  const cls = "size-3.5 text-foreground/70";
  switch (type) {
    case "FLIGHT":
      return <Plane className={cls} />;
    case "LODGING":
      return <BedDouble className={cls} />;
    case "TEE_TIME":
      return <Flag className={cls} />;
    case "DINING":
      return <UtensilsCrossed className={cls} />;
    case "NIGHTLIFE":
      return <Wine className={cls} />;
    case "TRANSPORT":
      return <Car className={cls} />;
    case "SPA":
      return <Flower2 className={cls} />;
    default:
      return <Sparkles className={cls} />;
  }
}

function StatusBadge({ kind }: { kind: RowStatus }) {
  switch (kind) {
    case "confirmed":
      return (
        <span className="grid size-5 place-items-center rounded-full bg-accent text-accent-foreground shrink-0">
          <Check className="size-3" strokeWidth={3} />
        </span>
      );
    case "booking":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <Loader2 className="size-3.5 animate-spin text-foreground" />
        </span>
      );
    case "review":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <ShieldCheck className="size-3.5 text-foreground" />
        </span>
      );
    case "failed":
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <AlertCircle className="size-3.5 text-foreground" />
        </span>
      );
    default:
      return (
        <span className="grid size-5 place-items-center shrink-0">
          <Circle className="size-3 text-muted-foreground/40" />
        </span>
      );
  }
}

function statusLabel(kind: RowStatus): string {
  switch (kind) {
    case "confirmed":
      return "Booked";
    case "booking":
      return "Booking…";
    case "review":
      return "Reviewing";
    case "failed":
      return "Needs you";
    default:
      return "Not booked yet";
  }
}

// Group items into a few high-level buckets so a 40-line wall of rows
// reads as 5 sections of 5-10 things each. Order is the customer's
// reading order — what to fly into first, where to sleep, what to
// play, what to eat, what to do, then plumbing (transport).
type CategoryKey =
  | "FLIGHTS"
  | "HOTELS"
  | "GOLF"
  | "DINING"
  | "ACTIVITIES"
  | "TRANSPORT";

const CATEGORY_ORDER: CategoryKey[] = [
  "FLIGHTS",
  "HOTELS",
  "GOLF",
  "DINING",
  "ACTIVITIES",
  "TRANSPORT",
];

const CATEGORY_META: Record<
  CategoryKey,
  { label: string; icon: React.ReactNode }
> = {
  FLIGHTS: { label: "Flights", icon: <Plane className="size-3.5" /> },
  HOTELS: { label: "Hotels", icon: <BedDouble className="size-3.5" /> },
  GOLF: { label: "Golf", icon: <Flag className="size-3.5" /> },
  DINING: { label: "Dining", icon: <UtensilsCrossed className="size-3.5" /> },
  ACTIVITIES: {
    label: "Activities",
    icon: <Sparkles className="size-3.5" />,
  },
  TRANSPORT: { label: "Transport", icon: <Car className="size-3.5" /> },
};

function categoryFor(type: WorkspaceItineraryItem["type"]): CategoryKey {
  switch (type) {
    case "FLIGHT":
      return "FLIGHTS";
    case "LODGING":
      return "HOTELS";
    case "TEE_TIME":
      return "GOLF";
    case "DINING":
      return "DINING";
    case "TRANSPORT":
      return "TRANSPORT";
    case "NIGHTLIFE":
    case "SPA":
    case "ACTIVITY":
    default:
      return "ACTIVITIES";
  }
}

export function BookingStatusPanel({
  tripId,
  itinerary,
  hasSavedCard,
}: {
  tripId: string;
  itinerary: WorkspaceItinerary | null;
  /** When false + there are agent-bookable items, we prompt to save a card
   *  so the agent can complete paid bookings end-to-end. */
  hasSavedCard?: boolean;
}) {
  const qc = useQueryClient();
  const [bookingId, setBookingId] = React.useState<string | null>(null);
  const [bookingAll, setBookingAll] = React.useState(false);
  // Pre-book review gate (Carson's call, June 2026): row taps + Book All
  // both pass through the shared Review & confirm dialog before anything
  // executes — regardless of which lane (API or agent) does the booking.
  const [confirmItem, setConfirmItem] =
    React.useState<WorkspaceItineraryItem | null>(null);
  const [confirmAllOpen, setConfirmAllOpen] = React.useState(false);

  const bookAll = React.useCallback(async () => {
    if (bookingAll || bookingId) return;
    setBookingAll(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/book-all`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        needsProfile?: boolean;
        error?: string;
        outcomes?: Array<{ status: string }>;
      } | null;
      if (!res.ok || !data?.ok) {
        toast.error(
          data?.error ?? "Couldn't book the trip — try again.",
        );
        return;
      }
      const booked =
        data.outcomes?.filter((o) => o.status === "booked").length ?? 0;
      // Agent items dispatched this request run async — their real status
      // lands on each card via live polling. Report them as "on it" now.
      const booking =
        data.outcomes?.filter((o) => o.status === "booking").length ?? 0;
      const failed =
        data.outcomes?.filter((o) => o.status === "failed").length ?? 0;
      if (failed > 0) {
        toast.error(
          `${failed} couldn't start — check the panel.${booking > 0 ? ` Pyltrix is booking ${booking} more.` : ""}`,
        );
      } else if (booking > 0) {
        toast.success(
          `Pyltrix is booking ${booking} ${booking === 1 ? "item" : "items"}${booked > 0 ? ` (${booked} already done)` : ""} — watch each card for progress.`,
        );
      } else {
        toast.success(
          booked > 0 ? `Trip locked in: ${booked} confirmed.` : "Nothing left to book.",
        );
      }
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBookingAll(false);
      setConfirmAllOpen(false);
    }
  }, [bookingAll, bookingId, qc, tripId]);

  // Tap a not-yet-booked row to have the agent book just that one.
  const bookItem = React.useCallback(
    async (item: WorkspaceItineraryItem) => {
      if (bookingId) return;
      setBookingId(item.id);
      try {
        const res = await fetch(
          `/api/trips/${tripId}/items/${item.id}/book-agent`,
          { method: "POST" },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          toast.error(err?.error ?? "Couldn't start that booking — try again.");
          return;
        }
        toast.success(`Pyltrix is booking ${item.title}.`);
        void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      } catch {
        toast.error("Network error — try again.");
      } finally {
        setBookingId(null);
        setConfirmItem(null);
      }
    },
    [bookingId, qc, tripId],
  );

  // Approve the agent's quoted price (it paused because the venue's real total
  // came in above the estimate). On approval the agent re-runs with the gate
  // lifted and finishes the booking.
  const [approvingId, setApprovingId] = React.useState<string | null>(null);
  const approvePrice = React.useCallback(
    async (item: WorkspaceItineraryItem) => {
      if (approvingId) return;
      setApprovingId(item.id);
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
        setApprovingId(null);
      }
    },
    [approvingId, qc, tripId],
  );

  // Live updates while any booking is mid-flight. The SSE nudge bridge pushes
  // progress when it's wired, but a cheap 6s refetch keeps the panel honest
  // (Booking… → Reviewing/Booked) even when the bridge isn't reachable.
  const anyInFlight = React.useMemo(
    () =>
      (itinerary?.items ?? []).some((it) =>
        ["PENDING", "SEARCHING", "HELD"].includes(it.booking?.status ?? ""),
      ),
    [itinerary],
  );
  React.useEffect(() => {
    if (!anyInFlight) return;
    // 10s, not 6s: each workspace refetch is a full DB snapshot that takes
    // 2-3s, and in local dev it runs in the SAME Node process as the agent —
    // a tight poll starves the agent's CPU and inflates every step. 10s keeps
    // the panel live without competing with the booking it's watching.
    const id = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    }, 10000);
    return () => clearInterval(id);
  }, [anyInFlight, qc, tripId]);

  // Remove an item the customer doesn't want (e.g. 6 golf rounds, they only
  // want one). Confirms first — the DELETE also cancels any booking tied to
  // the item server-side — then refetches the workspace so totals + the
  // category counters recompute. Mirrors the dialog's deleteItem flow.
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const removeItem = React.useCallback(
    async (item: WorkspaceItineraryItem) => {
      if (removingId || bookingId) return;
      if (
        !confirm(
          `Remove "${item.title}" from the trip? This also cancels any booking tied to it.`,
        )
      ) {
        return;
      }
      setRemovingId(item.id);
      try {
        const res = await fetch(
          `/api/trips/${tripId}/itinerary-items/${item.id}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          toast.error("Couldn't remove that — try again.");
          return;
        }
        toast.success("Removed from your trip.");
        void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      } catch {
        toast.error("Network error — try again.");
      } finally {
        setRemovingId(null);
      }
    },
    [removingId, bookingId, qc, tripId],
  );

  // Sold-out recovery: when an item failed with no_availability, fetch the
  // single best comparable alternative (Haiku swap call), apply it, and let
  // the row flip back to "Tap to book" on the new venue. Carson's call:
  // auto-SUGGEST (swap in the alternative), not auto-book — the customer
  // still taps to book the replacement. The swap endpoint resets the stale
  // booking so the row becomes bookable again.
  const [findingAltId, setFindingAltId] = React.useState<string | null>(null);
  const findAlternative = React.useCallback(
    async (item: WorkspaceItineraryItem) => {
      if (findingAltId || bookingId) return;
      setFindingAltId(item.id);
      try {
        const url = `/api/trips/${tripId}/itinerary-items/${item.id}/swap`;
        const res = await fetch(url);
        const data = (await res.json().catch(() => null)) as {
          alternatives?: Array<{
            name: string;
            description?: string;
            location?: string;
            estimatedCostUSD?: number;
          }>;
        } | null;
        const alt = data?.alternatives?.[0];
        if (!res.ok || !alt) {
          toast.error("Couldn't find an alternative — try the website below.");
          return;
        }
        const apply = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: alt.name,
            description: alt.description,
            location: alt.location,
            estimatedCostUSD: alt.estimatedCostUSD,
          }),
        });
        if (!apply.ok) {
          toast.error("Couldn't apply the alternative — try again.");
          return;
        }
        toast.success(
          `${item.title} was full — swapped in ${alt.name}. Tap to book it.`,
        );
        void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      } catch {
        toast.error("Network error — try again.");
      } finally {
        setFindingAltId(null);
      }
    },
    [findingAltId, bookingId, qc, tripId],
  );
  const items = React.useMemo(
    () => (itinerary?.items ?? []).filter((i) => i.type !== "FREE_TIME"),
    [itinerary],
  );

  if (!itinerary || items.length === 0) return null;

  const rows = items.map((item) => ({ item, ...statusFor(item) }));
  // Walk-in rows AND suggestion rows (restaurants/activities/nightlife/
  // spa) are shown in the list but EXCLUDED from the counter + progress
  // bar — we don't auto-book them, so counting them as "not confirmed"
  // would make a fully-handled trip read as incomplete forever. The
  // counter tracks only what the agent + Duffel actually book (flights,
  // hotels, golf, transport).
  const bookable = rows.filter(
    (r) =>
      !SUGGESTION_TYPES.has(r.item.type) &&
      r.item.reservationNeed !== "walk_in",
  );
  const total = bookable.length;
  const confirmed = bookable.filter((r) => r.kind === "confirmed").length;
  const inFlight = bookable.filter((r) => r.kind === "booking").length;
  const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;
  const allDone = confirmed === total;
  const hasUnbooked = bookable.some(
    (r) => r.kind === "pending" || r.kind === "failed",
  );

  // Bucket rows into ordered categories.
  const grouped = React.useMemo(() => {
    const buckets = new Map<CategoryKey, typeof rows>();
    for (const k of CATEGORY_ORDER) buckets.set(k, []);
    for (const r of rows) buckets.get(categoryFor(r.item.type))!.push(r);
    return CATEGORY_ORDER.filter(
      (k) => (buckets.get(k) ?? []).length > 0,
    ).map((k) => ({ key: k, items: buckets.get(k)! }));
  }, [rows]);

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      {/* Header — title + counter + progress + primary "Book all" CTA */}
      <header className="px-5 py-4 border-b border-border/60 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Booking status
          </p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {confirmed} of {total} confirmed
          </p>
        </div>
        <div className="h-px w-full bg-border overflow-hidden">
          <div
            className="h-full bg-foreground transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          {allDone
            ? "Everything's locked in. You're all set."
            : inFlight > 0
              ? "Pyltrix is booking your trip — watch each line confirm."
              : hasUnbooked
                ? "Hit Book all, or tap any single row to book just that one."
                : "Items will confirm here as the agent works."}
        </p>
        {hasUnbooked && (
          <button
            type="button"
            onClick={() => setConfirmAllOpen(true)}
            disabled={bookingAll || bookingId !== null}
            className={cn(
              "w-full h-11 rounded-xl bg-accent text-accent-foreground text-sm font-semibold",
              "hover:bg-accent/90 transition disabled:opacity-60 disabled:cursor-not-allowed",
              "inline-flex items-center justify-center gap-2",
            )}
          >
            {bookingAll ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Booking your trip…
              </>
            ) : (
              <>Book all</>
            )}
          </button>
        )}
        {/* Prompt to vault a card when there are agent-bookable items
            (hotels/golf/cars) and none is saved — without it the agent
            stops at the payment step instead of finishing the booking. */}
        {hasSavedCard === false &&
          rows.some((r) =>
            isAgentBookable(r.item.type, r.item.title, r.item.description),
          ) && <SaveCardButton returnTo={`/trips/${tripId}`} />}
      </header>

      {/* Grouped rows — collapsible categories so a 40-item trip reads
          as 5 sections of 5-10 things each instead of one overwhelming
          wall. Visible scrollbar on the outer scroll. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 space-y-1">
        {grouped.map(({ key, items: groupItems }) => {
          const groupConfirmed = groupItems.filter(
            (r) => r.kind === "confirmed",
          ).length;
          const meta = CATEGORY_META[key];
          // Dining + Activities are suggestion categories — we don't book
          // them, so a "0/5 confirmed" ratio would read as failure. Show a
          // plain count ("5 picks") instead.
          const isSuggestionCategory = key === "DINING" || key === "ACTIVITIES";
          // Default-collapse categories that are fully booked OR are
          // TRANSPORT (the plumbing); expand the rest so the customer
          // sees what still needs doing.
          const defaultOpen =
            !(groupConfirmed === groupItems.length) && key !== "TRANSPORT";
          return (
            <CategorySection
              key={key}
              label={meta.label}
              icon={meta.icon}
              total={groupItems.length}
              confirmed={groupConfirmed}
              suggestionMode={isSuggestionCategory}
              defaultOpen={defaultOpen}
            >
              {groupItems.map(
                ({
                  item,
                  kind,
                  code,
                  amountCents,
                  phone,
                  website,
                  failureReason,
                  screenshotUrl,
                  agentMessage,
                  quotedPriceCents,
                }) => {
                  // Walk-in venues (casual restaurants/activities Google
                  // says don't take reservations) get a distinct label
                  // and are NOT tappable.
                  const isWalkIn = item.reservationNeed === "walk_in";
                  // Suggestion venue (restaurant/nightlife/spa/activity).
                  // We never auto-book these — we hand the customer the
                  // venue's number + a pre-drafted email + the website and
                  // they book in one tap. Walk-ins among them need nothing.
                  const isSuggestion = SUGGESTION_TYPES.has(item.type);
                  const suggestionNeedsContact = isSuggestion && !isWalkIn;
                  // Phone/email-only venue (e.g. a small Portofino trattoria
                  // that takes reservations only by phone or email). The
                  // agent reported form_not_found — re-running it is futile,
                  // so we surface the venue's phone + a pre-drafted email.
                  const isPhoneOnly =
                    kind === "failed" && failureReason === "form_not_found";
                  // Sold out for the trip's dates. The venue exists and is
                  // bookable — there's just no inventory — so the concierge
                  // move is to offer a comparable alternative, not a dead end.
                  const isSoldOut =
                    kind === "failed" && failureReason === "no_availability";
                  // Private members-only club (e.g. Rock Creek Cattle Co.):
                  // the public can't book it AT ALL, ever. Same recovery —
                  // tell the customer plainly and offer a bookable alternative.
                  const isMembersOnly =
                    kind === "failed" && failureReason === "members_only";
                  const needsAlternative = isSoldOut || isMembersOnly;
                  // Hotels, golf, and car rentals are agent-bookable.
                  const canBook =
                    isAgentBookable(item.type, item.title, item.description) &&
                    !isWalkIn &&
                    !isPhoneOnly &&
                    (kind === "pending" || kind === "failed");
                  // Contact links (Call + Website) show for any suggestion
                  // venue that takes reservations, and as a fallback on a
                  // failed agent booking — so the customer always has a way
                  // to reach the venue. We don't draft emails or auto-book
                  // these; they reserve directly.
                  const showContacts = suggestionNeedsContact || kind === "failed";
                  // There's always a working "Website" link: the venue's
                  // real site when we have it, else a Google search for the
                  // venue so the customer can find it + its number.
                  const webHref =
                    website ??
                    `https://www.google.com/search?q=${encodeURIComponent(
                      `${item.title}${item.location ? ` ${item.location}` : ""}`,
                    )}`;
                  const isThisBooking = bookingId === item.id;
                  const statusText = isThisBooking
                    ? "Starting…"
                    : isWalkIn
                      ? "Walk-in · no booking needed"
                      : suggestionNeedsContact
                        ? "Reserve directly with the venue"
                        : isPhoneOnly
                          ? "Reservations by phone"
                          : canBook
                            ? "Tap to book"
                            : statusLabel(kind);
                  const rowInner = (
                    <>
                      {isSuggestion && !isThisBooking ? (
                        // Suggestions aren't a booking task — show the venue
                        // type icon, not a to-do circle that reads "unbooked".
                        <span className="grid size-5 place-items-center shrink-0">
                          <TypeIcon type={item.type} />
                        </span>
                      ) : (
                        <StatusBadge kind={isThisBooking ? "booking" : kind} />
                      )}
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "text-[13px] leading-snug truncate",
                            kind === "confirmed"
                              ? "font-medium text-foreground"
                              : "text-foreground/85",
                          )}
                        >
                          {item.title}
                        </p>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{statusText}</span>
                          {code && (
                            <span className="tabular-nums">· #{code}</span>
                          )}
                          {amountCents != null && amountCents > 0 && (
                            <span className="tabular-nums">
                              · ${Math.round(amountCents / 100).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  );
                  // The main row: a re-book button when the agent can retry,
                  // otherwise inert. Fallback links (call/site) render BELOW
                  // it for any failed booking.
                  const mainRow = canBook ? (
                    <button
                      type="button"
                      disabled={bookingId !== null}
                      onClick={() => setConfirmItem(item)}
                      className="w-full flex items-start gap-2.5 text-left rounded-lg px-2.5 py-2 hover:bg-surface-raised transition disabled:opacity-60"
                    >
                      {rowInner}
                    </button>
                  ) : (
                    <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
                      {rowInner}
                    </div>
                  );
                  return (
                    <div key={item.id}>
                      <div className="flex items-center">
                        <div className="min-w-0 flex-1">{mainRow}</div>
                        {/* Quick-remove: drop a round/item the customer
                            doesn't want without opening the dialog. Subtle
                            until hovered (and always tappable on touch),
                            turns red on hover. Confirm + cancel-any-booking
                            is handled in removeItem. */}
                        <button
                          type="button"
                          onClick={() => void removeItem(item)}
                          disabled={removingId !== null || bookingId !== null}
                          aria-label={`Remove ${item.title} from trip`}
                          title="Remove from trip"
                          className="shrink-0 mr-1 grid size-7 place-items-center rounded-lg text-muted-foreground/40 opacity-70 hover:opacity-100 hover:text-red-600 hover:bg-red-500/10 focus-visible:opacity-100 transition disabled:opacity-30 disabled:pointer-events-none"
                        >
                          {removingId === item.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <X className="size-3.5" />
                          )}
                        </button>
                      </div>
                      {needsAlternative && (
                        <div className="pl-9 pr-2.5 pb-2 -mt-0.5 space-y-1">
                          <p className="text-[11px] text-muted-foreground leading-snug">
                            {isMembersOnly
                              ? `${item.title} is a private members-only club — the public can't book it.`
                              : `${item.title} is sold out for your dates.`}
                          </p>
                          <button
                            type="button"
                            onClick={() => void findAlternative(item)}
                            disabled={findingAltId !== null || bookingId !== null}
                            className="inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--copper))] px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[hsl(var(--copper))]/90 transition disabled:opacity-60"
                          >
                            {findingAltId === item.id ? (
                              <>
                                <Loader2 className="size-3.5 animate-spin" />
                                Finding a bookable option…
                              </>
                            ) : (
                              <>
                                <Sparkles className="size-3.5" />
                                Find a bookable alternative
                              </>
                            )}
                          </button>
                        </div>
                      )}
                      {/* REVIEW — the agent reached a real page and stopped.
                          Show what it got to, the screenshot proof, and the
                          one action that finishes it (approve price / save
                          card). This is the "review button" the customer
                          expects after the agent runs. */}
                      {kind === "review" && (
                        <div className="pl-9 pr-2.5 pb-2.5 -mt-0.5 space-y-2">
                          {failureReason === "price_approval" &&
                          quotedPriceCents ? (
                            <>
                              <p className="text-[11px] text-foreground/80 leading-snug">
                                Found it — the venue&apos;s real total is{" "}
                                <span className="font-semibold tabular-nums">
                                  $
                                  {Math.round(
                                    quotedPriceCents / 100,
                                  ).toLocaleString()}
                                </span>
                                {item.cost != null
                                  ? `, above the $${Math.round(item.cost / 100).toLocaleString()} estimate.`
                                  : "."}{" "}
                                Everything else is filled in.
                              </p>
                              {screenshotUrl && (
                                <ScreenshotProof
                                  url={screenshotUrl}
                                  title={`Filled-in booking — ${item.title}`}
                                  caption="Tap to see what Pyltrix filled in"
                                />
                              )}
                              <button
                                type="button"
                                onClick={() => void approvePrice(item)}
                                disabled={approvingId !== null}
                                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-accent-foreground hover:bg-accent/90 transition disabled:opacity-60"
                              >
                                {approvingId === item.id ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : null}
                                Approve &amp; book — $
                                {Math.round(
                                  quotedPriceCents / 100,
                                ).toLocaleString()}
                              </button>
                            </>
                          ) : failureReason === "enquiry_sent" ? (
                            <>
                              <p className="text-[11px] text-foreground/80 leading-snug">
                                This venue is request-only — Pyltrix submitted
                                your reservation request with your dates, party,
                                and details. They&apos;ll confirm directly,
                                usually within a day.
                              </p>
                              {screenshotUrl && (
                                <ScreenshotProof
                                  url={screenshotUrl}
                                  title={`Request sent — ${item.title}`}
                                  caption="Tap to see the request Pyltrix sent"
                                />
                              )}
                            </>
                          ) : (
                            <>
                              <p className="text-[11px] text-foreground/80 leading-snug">
                                {agentMessage?.trim()
                                  ? `Pyltrix filled in the whole reservation — ${agentMessage.trim()}.`
                                  : "Pyltrix filled in the whole reservation and paused at the payment step."}
                              </p>
                              {screenshotUrl && (
                                <ScreenshotProof
                                  url={screenshotUrl}
                                  title={`Filled-in booking — ${item.title}`}
                                  caption="Tap to see what Pyltrix filled in"
                                />
                              )}
                              {hasSavedCard ? (
                                <p className="text-[11px] text-muted-foreground leading-snug">
                                  Pyltrix is completing the payment with your
                                  saved card — you&apos;ll get the confirmation
                                  by email.
                                </p>
                              ) : (
                                <SaveCardButton
                                  returnTo={`/trips/${tripId}`}
                                />
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {/* BOOKED — the venue's own confirmation page, captured. */}
                      {kind === "confirmed" && screenshotUrl && (
                        <div className="pl-9 pr-2.5 pb-2.5 -mt-0.5">
                          <ScreenshotProof
                            url={screenshotUrl}
                            title={`Venue confirmation — ${item.title}`}
                            caption="Tap to see the venue's confirmation"
                          />
                        </div>
                      )}
                      {showContacts && (
                        <div className="flex flex-wrap items-center gap-1.5 pl-9 pr-2.5 pb-2 -mt-0.5">
                          {phone && (
                            <a
                              href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] font-medium text-foreground/90 hover:bg-surface-raised hover:border-border transition"
                            >
                              <Phone className="size-3 text-muted-foreground" />
                              <span className="tabular-nums">{phone}</span>
                            </a>
                          )}
                          <a
                            href={webHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] font-medium text-foreground/90 hover:bg-surface-raised hover:border-border transition"
                          >
                            <Globe className="size-3 text-muted-foreground" />
                            Website
                          </a>
                        </div>
                      )}
                    </div>
                  );
                },
              )}
            </CategorySection>
          );
        })}
      </div>

      {/* Footer — the trophy state */}
      {allDone && (
        <footer className="px-5 py-4 border-t border-border/60 flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-foreground shrink-0">
            <PartyPopper className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-medium">You&apos;re all set</p>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Confirmations are on their way to your inbox.
            </p>
          </div>
        </footer>
      )}

      {/* Pre-book review gates */}
      {confirmItem && (
        <BookingConfirmDialog
          open={confirmItem !== null}
          onOpenChange={(o) => {
            if (!o) setConfirmItem(null);
          }}
          lines={[
            {
              title: confirmItem.title,
              detail: confirmDetailFor(confirmItem),
              costCents: confirmItem.cost,
            },
          ]}
          paymentNote={
            typeof confirmItem.cost === "number"
              ? "Paid securely by Pyltrix when the venue charges online; otherwise it settles at the property."
              : "Most venues like this settle at the property — nothing is charged up front."
          }
          busy={bookingId !== null}
          onConfirm={() => void bookItem(confirmItem)}
        />
      )}
      <BookingConfirmDialog
        open={confirmAllOpen}
        onOpenChange={setConfirmAllOpen}
        heading="Review your trip"
        lines={bookable
          .filter((r) => r.kind === "pending" || r.kind === "failed")
          .map((r) => ({
            title: r.item.title,
            detail: confirmDetailFor(r.item),
            costCents: r.item.cost,
          }))}
        totalCents={bookable
          .filter((r) => r.kind === "pending" || r.kind === "failed")
          .reduce((sum, r) => sum + (r.item.cost ?? 0), 0)}
        paymentNote="Flights are charged now; hotels, golf, and most venues settle at the property. You'll get every confirmation by email."
        confirmLabel="Confirm & book all"
        busy={bookingAll}
        onConfirm={() => void bookAll()}
      />
    </div>
  );
}

/**
 * Collapsible category section. Header shows icon + label + "X of Y"
 * counter + a chevron that rotates when open. Click anywhere on the
 * header to toggle. Booked-out / TRANSPORT default to closed so the
 * panel reads tight; in-progress + pending categories default to open.
 */
function CategorySection({
  label,
  icon,
  total,
  confirmed,
  suggestionMode = false,
  defaultOpen,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  total: number;
  confirmed: number;
  /** Suggestion categories (dining/activities) aren't booked, so show a
   *  plain count ("5 picks") instead of a confirmed/total ratio. */
  suggestionMode?: boolean;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border/40 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/60 rounded-xl transition"
      >
        <span className="grid size-5 place-items-center text-foreground/70 shrink-0">
          {icon}
        </span>
        <p className="text-[12px] font-semibold tracking-tight flex-1 truncate">
          {label}
        </p>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {suggestionMode
            ? `${total} ${total === 1 ? "pick" : "picks"}`
            : `${confirmed}/${total}`}
        </p>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="px-1 pb-1.5 pt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
  );
}
