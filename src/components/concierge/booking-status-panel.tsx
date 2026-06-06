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
  Mail,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  WorkspaceItinerary,
  WorkspaceItineraryItem,
  WorkspaceTrip,
  WorkspaceMe,
} from "./workspace";

// Item types the browser agent can book directly (matches
// AgentBookingPanel). Flights go through "Book all" (Duffel), FREE_TIME
// isn't a reservation, TRANSPORT is an Uber deep-link — so those rows
// aren't tap-to-book here.
const AGENT_BOOKABLE = new Set([
  "LODGING",
  "TEE_TIME",
  "DINING",
  "NIGHTLIFE",
  "SPA",
  "ACTIVITY",
]);

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
} {
  const b = item.booking ?? null;
  const phone = b?.fallbackContact?.phone ?? null;
  const website = b?.fallbackContact?.website ?? null;
  const email = b?.fallbackContact?.email ?? null;
  if (!b)
    return {
      kind: "pending",
      code: null,
      amountCents: null,
      phone: null,
      website: null,
      email: null,
      failureReason: null,
    };
  const base = { phone, website, email, failureReason: b.failureReason ?? null };
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
        <span className="grid size-5 place-items-center rounded-full bg-foreground text-background shrink-0">
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

/**
 * Build a pre-drafted reservation-request email for a venue with no
 * online booking form (phone/email-only). Returns a `mailto:` URL that
 * opens the customer's own mail client with the venue address, a subject,
 * and a complete body pre-filled — they review and hit send. Works whether
 * or not we captured the venue's email (an empty `to` just lets them paste
 * it). Deterministic, no AI call.
 */
function buildReservationMailto(args: {
  item: WorkspaceItineraryItem;
  venueEmail: string | null;
  travelerName: string | null;
  travelerPhone: string | null;
  partySize: number | null;
}): string {
  const { item, venueEmail, travelerName, travelerPhone, partySize } = args;
  const venue = item.title.replace(
    /^(dinner|lunch|breakfast|brunch|drinks|cocktails|round|tee\s*time|spa|massage)\s*(—|–|-|:|at)\s*/i,
    "",
  );
  const when = item.startTime ? new Date(item.startTime) : null;
  const dateStr = when
    ? when.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
  const timeStr =
    when && !(when.getUTCHours() === 0 && when.getUTCMinutes() === 0)
      ? when.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
        })
      : null;

  const lines: string[] = [
    `Hello ${venue},`,
    "",
    "I'd like to request a reservation:",
    "",
  ];
  if (dateStr) lines.push(`• Date: ${dateStr}`);
  if (timeStr) lines.push(`• Time: ${timeStr}`);
  if (partySize && partySize > 0) lines.push(`• Party size: ${partySize}`);
  if (travelerName) lines.push(`• Name: ${travelerName}`);
  lines.push(
    "",
    "Could you please confirm availability? Thank you very much.",
    "",
    travelerName ?? "",
  );
  if (travelerPhone) lines.push(travelerPhone);

  const subject = `Reservation request — ${venue}${dateStr ? `, ${dateStr}` : ""}`;
  const body = lines.join("\n");
  const to = venueEmail ?? "";
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}

export function BookingStatusPanel({
  tripId,
  itinerary,
  trip,
  me,
}: {
  tripId: string;
  itinerary: WorkspaceItinerary | null;
  trip?: WorkspaceTrip | null;
  me?: WorkspaceMe | null;
}) {
  const qc = useQueryClient();
  const [bookingId, setBookingId] = React.useState<string | null>(null);
  const [bookingAll, setBookingAll] = React.useState(false);

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
      const pencilled =
        data.outcomes?.filter((o) => o.status === "pencilled").length ?? 0;
      const failed =
        data.outcomes?.filter((o) => o.status === "failed").length ?? 0;
      if (failed > 0) {
        toast.error(
          `Booked ${booked}, pencilled ${pencilled}, ${failed} failed — check the panel.`,
        );
      } else {
        toast.success(
          `Trip locked in: ${booked} confirmed${pencilled > 0 ? `, ${pencilled} pencilled` : ""}.`,
        );
      }
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setBookingAll(false);
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
      }
    },
    [bookingId, qc, tripId],
  );

  // Everything that's meant to be booked. FREE_TIME isn't a reservation.
  const items = React.useMemo(
    () => (itinerary?.items ?? []).filter((i) => i.type !== "FREE_TIME"),
    [itinerary],
  );

  if (!itinerary || items.length === 0) return null;

  const rows = items.map((item) => ({ item, ...statusFor(item) }));
  // Walk-in rows are shown in the list but EXCLUDED from the counter +
  // progress bar — they don't need booking, so counting them as "not
  // confirmed" would make a 9-of-10 trip read as 7-of-10 forever.
  const bookable = rows.filter((r) => r.item.reservationNeed !== "walk_in");
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
            onClick={() => void bookAll()}
            disabled={bookingAll || bookingId !== null}
            className={cn(
              "w-full h-11 rounded-xl bg-foreground text-background text-sm font-semibold",
              "hover:bg-foreground/90 transition disabled:opacity-60 disabled:cursor-not-allowed",
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
                  email,
                  failureReason,
                }) => {
                  // Walk-in venues (casual restaurants/activities Google
                  // says don't take reservations) get a distinct label
                  // and are NOT tappable — running the agent on them
                  // just wastes Browserbase time.
                  const isWalkIn = item.reservationNeed === "walk_in";
                  // Phone/email-only venue (e.g. a small Portofino trattoria
                  // that takes reservations only by phone or email). The
                  // agent reported form_not_found — re-running it is futile,
                  // so we DON'T make the row a re-book button; instead we
                  // surface the venue's phone (one-tap call) and a
                  // pre-drafted reservation email the customer just sends.
                  const isPhoneOnly =
                    kind === "failed" && failureReason === "form_not_found";
                  const canBook =
                    AGENT_BOOKABLE.has(item.type) &&
                    !isWalkIn &&
                    !isPhoneOnly &&
                    (kind === "pending" || kind === "failed");
                  // Any failed booking offers a manual fallback (call /
                  // email / visit site) so the customer is never at a dead
                  // end. We always offer "Draft email" on a phone/email-only
                  // venue even if we didn't capture the address — the mailto
                  // body is still pre-filled; they just add the recipient.
                  const showEmailDraft = isPhoneOnly || Boolean(email);
                  const showFallback =
                    kind === "failed" &&
                    Boolean(phone || website || showEmailDraft);
                  const isThisBooking = bookingId === item.id;
                  const statusText = isThisBooking
                    ? "Starting…"
                    : isWalkIn
                      ? "Walk-in · no booking needed"
                      : isPhoneOnly
                        ? phone && email
                          ? "Reservations by phone or email"
                          : email
                            ? "Reservations by email"
                            : "Reservations by phone"
                        : canBook
                          ? "Tap to book"
                          : statusLabel(kind);
                  const rowInner = (
                    <>
                      <StatusBadge kind={isThisBooking ? "booking" : kind} />
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
                      onClick={() => void bookItem(item)}
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
                      {mainRow}
                      {showFallback && (
                        <div className="flex flex-wrap items-center gap-2 pl-9 pr-2.5 pb-1.5">
                          {showEmailDraft && (
                            <a
                              href={buildReservationMailto({
                                item,
                                venueEmail: email,
                                travelerName:
                                  [
                                    me?.profile.legalGivenName,
                                    me?.profile.legalFamilyName,
                                  ]
                                    .filter(Boolean)
                                    .join(" ")
                                    .trim() ||
                                  me?.name ||
                                  null,
                                travelerPhone: me?.profile.phone ?? null,
                                partySize: trip?.groupSize ?? null,
                              })}
                              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background hover:bg-foreground/90 transition"
                            >
                              <Mail className="size-3" />
                              Draft email
                            </a>
                          )}
                          {phone && (
                            <a
                              href={`tel:${phone.replace(/[^\d+]/g, "")}`}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition",
                                showEmailDraft
                                  ? "border border-border text-foreground/80 hover:bg-surface-raised"
                                  : "bg-foreground text-background hover:bg-foreground/90",
                              )}
                            >
                              <Phone className="size-3" />
                              Call{" "}
                              <span className="tabular-nums opacity-80">
                                {phone}
                              </span>
                            </a>
                          )}
                          {website && (
                            <a
                              href={website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground/80 hover:bg-surface-raised transition"
                            >
                              <Globe className="size-3" />
                              Visit site
                            </a>
                          )}
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
          <span className="grid size-7 place-items-center rounded-lg bg-foreground text-background shrink-0">
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
  defaultOpen,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  total: number;
  confirmed: number;
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
          {confirmed}/{total}
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
