"use client";

import * as React from "react";
import {
  CalendarRange,
  Loader2,
  Sparkles,
  Plane,
  BedDouble,
  Flag,
  Car,
  Utensils,
  Martini,
  Waves,
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CheckCircle2,
  Trash2,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import type { ItineraryItemType } from "@prisma/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatCurrency, formatDateRange } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookingDetailsDialog } from "./booking-details-dialog";
import { SuggestedFlightDialog } from "./suggested-flight-dialog";
import { FlightBookingModal } from "./flight-booking-modal";
import { buildUberDeepLink } from "@/lib/uber-deep-link";
import type {
  WorkspaceBooking,
  WorkspaceItinerary,
  WorkspaceItineraryItem,
  WorkspaceTrip,
  WorkspaceMe,
  SuggestedFlightOffer,
} from "./workspace";

export function LivePreview({
  tripId,
  trip,
  me,
  itinerary,
  bookings = [],
}: {
  tripId: string;
  trip: WorkspaceTrip;
  me: WorkspaceMe;
  itinerary: WorkspaceItinerary | null;
  bookings?: WorkspaceBooking[];
}) {
  // Surface a build-failure banner when the quiz redirected here with
  // `?buildError=...`. The trip row already exists (the quiz saved it
  // before calling the AI), so the user can edit their answers and
  // retry instead of starting from scratch.
  const topLevelSearchParams = useSearchParams();
  const router = useRouter();
  const buildError = topLevelSearchParams?.get("buildError") ?? null;
  const dismissBuildError = React.useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("buildError");
    router.replace(url.pathname + url.search);
  }, [router]);

  const datesLine = trip.startDate
    ? formatDateRange(
        new Date(trip.startDate),
        trip.endDate ? new Date(trip.endDate) : null,
      )
    : null;
  const subtitleParts = [
    datesLine,
    trip.groupSize ? `${trip.groupSize} player${trip.groupSize > 1 ? "s" : ""}` : null,
  ].filter(Boolean) as string[];

  const groups = React.useMemo(() => groupBookings(bookings), [bookings]);

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Live trip
          </p>
          {itinerary && (
            <Badge variant="navy" size="sm">
              v{itinerary.version}
            </Badge>
          )}
        </div>
        <h2 className="mt-1 text-display text-xl tracking-tight truncate">
          {trip.destination ?? "Destination forming…"}
        </h2>
        {subtitleParts.length > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarRange className="size-3" />
            {subtitleParts.join(" · ")}
          </p>
        )}
      </header>

      <ScrollArea className="flex-1">
        {buildError && (
          <div className="mx-4 mt-4 rounded-2xl border border-red-500/30 bg-red-500/8 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-sm font-semibold text-red-500">
                  We couldn&apos;t finish your itinerary
                </p>
                <p className="text-xs text-foreground/80 leading-relaxed break-words">
                  {buildError}
                </p>
                <p className="text-[11px] text-muted-foreground pt-1">
                  Your answers are still saved. Tweak them and try again, or
                  ask us in your own words below.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissBuildError}
                className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => router.push(`/build/${tripId}`)}
              >
                Edit answers &amp; retry
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push("/dashboard")}
              >
                Back to dashboard
              </Button>
            </div>
          </div>
        )}
        <TotalsBanner
          itinerary={itinerary}
          bookings={bookings}
          suggestedFlights={trip.suggestedFlights}
        />
        {trip.suggestedFlights && trip.suggestedFlights.offers.length > 0 && (
          <SuggestedFlightsSection
            tripId={tripId}
            suggested={trip.suggestedFlights}
            me={me}
          />
        )}
        {itinerary && itinerary.items.length > 0 && (
          <ItineraryCategoriesSection tripId={tripId} itinerary={itinerary} />
        )}
        {groups.length === 0 ? (
          !trip.suggestedFlights && (!itinerary || itinerary.items.length === 0) ? (
            <ChecklistEmpty />
          ) : null
        ) : (
          <div className="px-4 py-4 space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Booked
              </p>
              <p className="text-[10px] text-muted-foreground tabular-nums">
                {bookings.length}{" "}
                {bookings.length === 1 ? "item" : "items"}
              </p>
            </div>
            {groups.map((g) => (
              <ChecklistRow key={g.key} group={g} tripId={tripId} />
            ))}
          </div>
        )}
      </ScrollArea>
      <BookAllPanel
        tripId={tripId}
        bookings={bookings}
        itinerary={itinerary}
        suggestedFlights={trip.suggestedFlights}
      />
      <CartFooter tripId={tripId} bookings={bookings} />
    </div>
  );
}

/**
 * "Book all my reservations" CTA. Shows on quiz-built trips with an
 * itinerary but no bookings yet. One click iterates every actionable
 * item through its provider integration via /book-all. Real partners
 * (Duffel) issue real confirmations; pending partners (Hotelbeds,
 * Lightspeed) record stub bookings that flip live once those keys
 * land. Hides itself once bookings exist — the CartFooter (payment
 * CTA) takes over from there.
 */
function BookAllPanel({
  tripId,
  bookings,
  itinerary,
  suggestedFlights,
}: {
  tripId: string;
  bookings: WorkspaceBooking[];
  itinerary: WorkspaceItinerary | null;
  suggestedFlights: WorkspaceTrip["suggestedFlights"];
}) {
  const qc = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);

  // Hide once the trip has any confirmed booking — the payment
  // CartFooter takes over.
  const anyBooked = bookings.some((b) => b.status === "CONFIRMED");
  if (anyBooked) return null;

  // Need at least an itinerary OR suggested flights to book anything.
  const hasSomething =
    (itinerary && itinerary.items.length > 0) ||
    (suggestedFlights && suggestedFlights.offers.length > 0);
  if (!hasSomething) return null;

  const bookAll = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/book-all`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        needsProfile?: boolean;
        error?: string;
        outcomes?: Array<{
          category: string;
          status: string;
          title: string;
          detail?: string;
        }>;
      } | null;
      if (!res.ok || !data?.ok) {
        if (data?.needsProfile) {
          toast.error(
            data.error ??
              "Fill in your traveler profile first, then re-run Book All.",
          );
        } else {
          toast.error(data?.error ?? "Couldn't book the trip.");
        }
        return;
      }
      const booked = data.outcomes?.filter((o) => o.status === "booked").length ?? 0;
      const pencilled =
        data.outcomes?.filter((o) => o.status === "pencilled").length ?? 0;
      const failed =
        data.outcomes?.filter((o) => o.status === "failed").length ?? 0;
      if (failed > 0) {
        toast.error(
          `Booked ${booked}, pencilled ${pencilled}, ${failed} failed — check the workspace.`,
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
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-[hsl(var(--copper))]/10 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Ready to lock it in?
          </p>
          <p className="text-sm text-foreground/85 leading-snug mt-0.5">
            One click — flights, lodging, golf, dining, transport.
          </p>
        </div>
        <Button
          size="sm"
          onClick={bookAll}
          disabled={submitting}
          className="shrink-0 bg-[hsl(var(--copper))] text-white hover:bg-[hsl(var(--copper))]/90"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              Booking…
            </>
          ) : (
            "Book all"
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booking checklist
// ---------------------------------------------------------------------------

type ChecklistCategory =
  | "flight"
  | "hotel"
  | "tee_time"
  | "transport"
  | "dining"
  | "spa"
  | "activity";

type ChecklistGroup = {
  key: string;
  category: ChecklistCategory;
  label: string; // "Flights", "Hotel", "Tee times"
  summary: string; // "3 tickets via American" or "Omni Barton Creek · 3 rooms"
  totalCost: number;
  hasStub: boolean;
  bookings: WorkspaceBooking[];
};

function categoryOf(type: ItineraryItemType): ChecklistCategory {
  switch (type) {
    case "FLIGHT":
      return "flight";
    case "LODGING":
      return "hotel";
    case "TEE_TIME":
      return "tee_time";
    case "TRANSPORT":
      return "transport";
    case "DINING":
    case "NIGHTLIFE":
      return "dining";
    case "SPA":
      return "spa";
    default:
      return "activity";
  }
}

function categoryLabel(c: ChecklistCategory, count: number): string {
  switch (c) {
    case "flight":
      return count === 1 ? "Flight" : "Flights";
    case "hotel":
      return count === 1 ? "Hotel" : "Hotels";
    case "tee_time":
      return count === 1 ? "Tee time" : "Tee times";
    case "transport":
      return count === 1 ? "Transport" : "Transport";
    case "dining":
      return count === 1 ? "Dining" : "Dining";
    case "spa":
      return "Spa";
    case "activity":
      return "Activity";
  }
}

function iconFor(c: ChecklistCategory) {
  switch (c) {
    case "flight":
      return Plane;
    case "hotel":
      return BedDouble;
    case "tee_time":
      return Flag;
    case "transport":
      return Car;
    case "dining":
      return Utensils;
    case "spa":
      return Waves;
    case "activity":
      return Activity;
  }
}

/**
 * Group bookings into checklist rows. Same-category + same-vendor
 * bookings collapse into one row (e.g. 3 American Airlines flights →
 * one "Flights · 3 tickets via American" row). When a category has
 * mixed vendors we still emit one row per vendor.
 */
function groupBookings(bookings: WorkspaceBooking[]): ChecklistGroup[] {
  if (bookings.length === 0) return [];

  // Bucket by (category, vendor) — vendor may be null
  const buckets = new Map<string, WorkspaceBooking[]>();
  const orderedKeys: string[] = [];
  for (const b of bookings) {
    const cat = categoryOf(b.type);
    const vendorKey = (b.vendor ?? b.title ?? "").trim().toLowerCase();
    const key = `${cat}::${vendorKey}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      orderedKeys.push(key);
    }
    buckets.get(key)!.push(b);
  }

  // Stable category sort so the panel reads top-down in trip order
  const categoryOrder: ChecklistCategory[] = [
    "flight",
    "hotel",
    "tee_time",
    "transport",
    "dining",
    "spa",
    "activity",
  ];
  orderedKeys.sort((a, b) => {
    const catA = a.split("::")[0] as ChecklistCategory;
    const catB = b.split("::")[0] as ChecklistCategory;
    return categoryOrder.indexOf(catA) - categoryOrder.indexOf(catB);
  });

  return orderedKeys.map((key) => {
    const list = buckets.get(key)!;
    const cat = list[0] ? categoryOf(list[0].type) : "activity";
    const vendor = list[0]?.vendor?.trim() ?? null;
    const totalCost = list.reduce((sum, b) => sum + (b.cost ?? 0), 0);
    const hasStub = list.some((b) => b.isStub);

    let label = categoryLabel(cat, list.length);
    let summary = "";

    if (cat === "flight") {
      const n = list.length;
      summary = vendor
        ? `${n} ticket${n > 1 ? "s" : ""} via ${vendor}`
        : `${n} ticket${n > 1 ? "s" : ""}`;
    } else if (cat === "hotel") {
      const rooms = list.length;
      summary = vendor
        ? `${vendor}${rooms > 1 ? ` · ${rooms} rooms` : ""}`
        : `${rooms} room${rooms > 1 ? "s" : ""}`;
    } else if (cat === "tee_time") {
      const n = list.length;
      summary = `${n} round${n > 1 ? "s" : ""}`;
    } else if (cat === "transport") {
      summary = vendor ?? list[0]?.title ?? "Booked";
    } else if (cat === "dining") {
      const n = list.length;
      summary = n === 1
        ? (vendor ?? list[0]?.title ?? "Reservation")
        : `${n} reservations`;
    } else {
      summary = vendor ?? list[0]?.title ?? "Booked";
    }

    return {
      key,
      category: cat,
      label,
      summary,
      totalCost,
      hasStub,
      bookings: list,
    };
  });
}

function ChecklistRow({ group, tripId }: { group: ChecklistGroup; tripId: string }) {
  const [open, setOpen] = React.useState(false);
  const Icon = iconFor(group.category);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-card/60 transition",
        group.hasStub
          ? "border-[hsl(var(--copper))]/40"
          : "border-border/70 hover:border-foreground/15",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left"
        aria-expanded={open}
      >
        <div
          className={cn(
            "size-8 rounded-lg grid place-items-center shrink-0",
            group.hasStub
              ? "bg-[hsl(var(--copper))]/15 text-[hsl(var(--copper))]"
              : "bg-[hsl(var(--emerald))]/15 text-[hsl(var(--emerald))]",
          )}
        >
          {group.hasStub ? (
            <Icon className="size-3.5" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none">
            {group.label}
          </p>
          <p className="text-sm font-medium leading-tight mt-1 truncate">
            {group.summary}
          </p>
        </div>
        <div className="text-right shrink-0 flex items-center gap-2">
          {group.totalCost > 0 && (
            <p className="text-sm font-semibold tabular-nums">
              {formatCurrency(group.totalCost / 100)}
            </p>
          )}
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition",
              open && "rotate-180",
            )}
          />
        </div>
      </button>

      {open && (
        <div className="px-3.5 pb-3 pt-1 space-y-3 border-t border-border/40">
          {group.bookings.map((b) => (
            <BookingDetail
              key={b.id}
              booking={b}
              category={group.category}
              tripId={tripId}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function BookingDetail({
  booking,
  tripId,
}: {
  booking: WorkspaceBooking;
  category: ChecklistCategory;
  tripId: string;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = React.useState(false);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (removing) return;
    const ok = window.confirm(
      booking.isSandbox
        ? "Remove this booking from the workspace? (Sandbox booking — no real money to refund.)"
        : `Remove this booking from the workspace?\n\nThis clears it from your trip view but does NOT cancel the reservation with the airline / hotel. To get a refund or credit, contact the provider directly using your confirmation number.`,
    );
    if (!ok) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/bookings/${booking.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Remove failed (${res.status})`);
      await qc.invalidateQueries({ queryKey: ["workspace", tripId] });
      toast.success("Booking removed from workspace.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't remove the booking.",
      );
      setRemoving(false);
    }
  };

  const copyRef = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!booking.confirmationCode) return;
    try {
      await navigator.clipboard.writeText(booking.confirmationCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard might be blocked
    }
  };

  const titleLine = booking.summary ?? booking.title;
  // Show 'View details' for flights (we have rich slice data) and as a
  // fallback for any booking with a confirmation. It's the primary trust
  // signal — customers should always be able to open a full in-app view.
  const canShowDetails = Boolean(booking.confirmationCode);

  return (
    <div className="pt-2 first:pt-0 space-y-1.5">
      <p className="text-xs text-foreground/80 leading-snug">{titleLine}</p>

      {booking.confirmationCode && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={copyRef}
            className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold tabular-nums hover:text-[hsl(var(--copper))] transition"
            title="Copy confirmation"
          >
            {booking.confirmationCode}
            <Copy className="size-3 opacity-60" />
            {copied && (
              <span className="text-[10px] text-[hsl(var(--emerald))] font-sans font-normal inline-flex items-center gap-1">
                <CheckCircle2 className="size-3" /> Copied
              </span>
            )}
          </button>
          {canShowDetails && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDetailOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold border border-[hsl(var(--navy))]/50 bg-[hsl(var(--navy))]/10 text-[hsl(var(--navy))] hover:bg-[hsl(var(--navy))]/20 transition shrink-0"
            >
              View booking
            </button>
          )}
        </div>
      )}

      {booking.isSandbox && (
        <p className="text-[10px] text-[hsl(var(--copper))]/90">
          Sandbox test booking — real airline verification activates with a live Duffel key.
        </p>
      )}

      {booking.partyNames && booking.partyNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {booking.partyNames.map((n, i) => (
            <span
              key={i}
              className="text-[10px] px-2 py-0.5 rounded-full bg-surface-raised/70 text-muted-foreground"
            >
              {n}
            </span>
          ))}
        </div>
      )}

      {booking.contactEmail && !booking.isStub && !booking.isSandbox && (
        <p className="text-[10px] text-muted-foreground">
          Confirmation will be emailed to {booking.contactEmail}
        </p>
      )}
      {booking.isStub && (
        <p className="text-[10px] text-[hsl(var(--copper))]/90">
          Pencilled in — we&apos;ll lock this with the partner once API access lands.
        </p>
      )}

      <div className="pt-1.5 flex items-center justify-end">
        <button
          type="button"
          onClick={handleRemove}
          disabled={removing}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground/80 hover:text-destructive transition disabled:opacity-50 disabled:hover:text-muted-foreground/80"
          title="Remove from workspace. Does not cancel with the provider."
        >
          {removing ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Removing
            </>
          ) : (
            <>
              <Trash2 className="size-3" />
              Remove
            </>
          )}
        </button>
      </div>

      {canShowDetails && (
        <BookingDetailsDialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
          booking={booking}
        />
      )}
    </div>
  );
}

type FlightRefineModifier =
  | "cheaper"
  | "nonstop"
  | "earlier"
  | "later"
  | "different_airline";

const REFINE_CHIPS: Array<{
  id: FlightRefineModifier;
  label: string;
}> = [
  { id: "cheaper", label: "Cheaper" },
  { id: "nonstop", label: "Nonstop only" },
  { id: "earlier", label: "Earlier" },
  { id: "later", label: "Later" },
  { id: "different_airline", label: "Different airline" },
];

function SuggestedFlightsSection({
  tripId,
  suggested,
  me,
}: {
  tripId: string;
  suggested: NonNullable<WorkspaceTrip["suggestedFlights"]>;
  me: WorkspaceMe;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeOffer, setActiveOffer] =
    React.useState<SuggestedFlightOffer | null>(null);
  const [bookingOffer, setBookingOffer] =
    React.useState<SuggestedFlightOffer | null>(null);
  const [refining, setRefining] = React.useState<FlightRefineModifier | null>(
    null,
  );

  // Auto-open used to fire from ?autoBook=1 — removed. The user wants
  // to see the result page first, swap items they don't like, then hit
  // the "Book All" CTA when they're ready. We still strip the URL
  // param if present so old bookmarks don't keep re-triggering once
  // the new flow ships.
  React.useEffect(() => {
    if (searchParams?.get("autoBook") !== "1") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("autoBook");
    router.replace(url.pathname + url.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Per-card refinement: zero AI cost. Hits the refine-flights endpoint
  // which re-runs Duffel with adjusted params + client-side filters and
  // overwrites the trip's suggestedFlights block. The workspace query
  // gets invalidated by the SSE nudge so cards refresh in place.
  const refine = async (modifier: FlightRefineModifier) => {
    if (refining) return;
    setRefining(modifier);
    try {
      const res = await fetch(`/api/trips/${tripId}/refine-flights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modifier }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; count?: number }
        | null;
      if (!res.ok || data?.error) {
        toast.error(data?.error ?? "Couldn't refine the flight options.");
      } else {
        const label = REFINE_CHIPS.find((c) => c.id === modifier)?.label ?? "";
        toast.success(
          `Updated ${data?.count ?? 0} ${label.toLowerCase()} options.`,
        );
      }
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setRefining(null);
    }
  };

  // Open the booking modal for a specific offer. Replaces the old
  // "send a chat message" detour — the modal collects the passenger
  // fields once (pre-filled from the user's saved profile if they've
  // booked before) and hits /book-flight directly.
  const openBookingFor = (offer: SuggestedFlightOffer) => {
    setActiveOffer(null);
    setBookingOffer(offer);
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };
  const fmtDuration = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  };

  return (
    <>
      <div className="px-4 pt-4 pb-3 space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Pick your flight
          </p>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {suggested.origin} ⇄ {suggested.destination} ·{" "}
            {suggested.passengers}{" "}
            {suggested.passengers === 1 ? "pax" : "pax"} ·{" "}
            {suggested.cabin.replace("_", " ")}
          </p>
        </div>
        {/* Refinement chips: re-run search with adjusted filters. No AI
            cost — these are the primary lever for "what if?" without
            burning model tokens on every tweak. */}
        <div className="flex flex-wrap gap-1.5 px-1">
          {REFINE_CHIPS.map((chip) => {
            const isLoading = refining === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => refine(chip.id)}
                disabled={!!refining}
                className={cn(
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium border transition",
                  "border-border/60 bg-surface-raised/60 text-foreground/80",
                  "hover:border-foreground/30 hover:bg-surface-raised",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  isLoading &&
                    "border-[hsl(var(--copper))]/50 bg-[hsl(var(--copper))]/10",
                )}
              >
                {isLoading ? "Searching…" : chip.label}
              </button>
            );
          })}
        </div>
        {suggested.offers.map((offer, idx) => {
          const total = Math.round(offer.totalAmount / 100);
          const out = offer.slices[0];
          const ret = offer.slices[1];
          return (
            <button
              key={offer.id}
              type="button"
              onClick={() => setActiveOffer(offer)}
              className="w-full text-left rounded-2xl border border-border/60 bg-surface-raised/70 p-3 hover:border-[hsl(var(--copper))]/50 hover:bg-surface-raised transition"
            >
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <p className="font-semibold text-sm leading-none truncate">
                  {offer.airlineName}
                  {idx === 0 && (
                    <span className="ml-2 text-[10px] uppercase tracking-widest text-[hsl(var(--copper))] font-medium">
                      best fit
                    </span>
                  )}
                </p>
                <p className="text-base font-semibold tabular-nums">
                  ${total.toLocaleString()}
                </p>
              </div>
              {out && (
                <div className="text-xs text-foreground/85 flex items-center gap-2 leading-snug">
                  <span className="tabular-nums font-mono">{out.origin}</span>
                  <span className="text-muted-foreground/70">
                    {fmtTime(out.departing)}
                  </span>
                  <span className="text-muted-foreground/40">→</span>
                  <span className="tabular-nums font-mono">
                    {out.destination}
                  </span>
                  <span className="text-muted-foreground/70">
                    {fmtTime(out.arriving)}
                  </span>
                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                    {fmtDate(out.departing)} ·{" "}
                    {fmtDuration(out.durationMinutes)} ·{" "}
                    {out.stops === 0
                      ? "nonstop"
                      : `${out.stops} stop${out.stops > 1 ? "s" : ""}`}
                  </span>
                </div>
              )}
              {ret && (
                <div className="mt-1 text-xs text-foreground/85 flex items-center gap-2 leading-snug">
                  <span className="tabular-nums font-mono">{ret.origin}</span>
                  <span className="text-muted-foreground/70">
                    {fmtTime(ret.departing)}
                  </span>
                  <span className="text-muted-foreground/40">→</span>
                  <span className="tabular-nums font-mono">
                    {ret.destination}
                  </span>
                  <span className="text-muted-foreground/70">
                    {fmtTime(ret.arriving)}
                  </span>
                  <span className="ml-auto text-muted-foreground/60 text-[10px]">
                    {fmtDate(ret.departing)} ·{" "}
                    {fmtDuration(ret.durationMinutes)} ·{" "}
                    {ret.stops === 0
                      ? "nonstop"
                      : `${ret.stops} stop${ret.stops > 1 ? "s" : ""}`}
                  </span>
                </div>
              )}
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground">
                  ${Math.round(offer.perPassengerAmount / 100).toLocaleString()}{" "}
                  per traveller
                </p>
                <span className="text-[11px] font-medium px-3 py-1 rounded-full border border-[hsl(var(--copper))]/40 bg-[hsl(var(--copper))]/10 text-[hsl(var(--copper))]">
                  View &amp; book →
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {activeOffer && (
        <SuggestedFlightDialog
          open={!!activeOffer}
          onOpenChange={(o) => {
            if (!o) setActiveOffer(null);
          }}
          offer={activeOffer}
          passengers={suggested.passengers}
          cabin={suggested.cabin}
          onBookRequested={openBookingFor}
        />
      )}
      {bookingOffer && (
        <FlightBookingModal
          open={!!bookingOffer}
          onOpenChange={(o) => {
            if (!o) setBookingOffer(null);
          }}
          tripId={tripId}
          offer={bookingOffer}
          passengerCount={suggested.passengers}
          cabin={suggested.cabin}
          profile={me.profile}
          defaultEmail={me.email}
          onBooked={() => {
            // Workspace query will pick up the new booking via the
            // realtime nudge fired by the booking endpoint.
          }}
        />
      )}
    </>
  );
}

/**
 * Trip-level totals summary. Sits between the header and the action
 * sections so the customer always sees the running cost and the
 * planned-vs-booked status at a glance.
 *
 *   Estimated total = sum of itinerary item costs (planned, not yet
 *     paid). Updates immediately when an item is deleted because
 *     deleting removes the row.
 *   Booked = sum of confirmation-priced bookings (real money committed).
 */
function TotalsBanner({
  itinerary,
  bookings,
  suggestedFlights,
}: {
  itinerary: WorkspaceItinerary | null;
  bookings: WorkspaceBooking[];
  suggestedFlights: WorkspaceTrip["suggestedFlights"];
}) {
  const itineraryTotal =
    itinerary?.items.reduce((sum, it) => sum + (it.cost ?? 0), 0) ?? 0;
  const bookedTotal = bookings
    .filter((b) => b.status === "CONFIRMED")
    .reduce((sum, b) => sum + (b.cost ?? 0), 0);
  const cheapestSuggestedFlight =
    suggestedFlights && suggestedFlights.offers.length > 0
      ? Math.min(...suggestedFlights.offers.map((o) => o.totalAmount))
      : 0;
  // Best-case full-trip estimate: planned itinerary + cheapest flight
  // option if not yet booked. We don't double-count: if a flight is
  // booked, the booking row already includes that cost; the cheapest-
  // suggested layer only contributes when there's no real booking yet.
  const hasBookedFlight = bookings.some(
    (b) => b.type === "FLIGHT" && b.status === "CONFIRMED",
  );
  const flightProvision = hasBookedFlight ? 0 : cheapestSuggestedFlight;
  const grandTotal = itineraryTotal + flightProvision;

  if (grandTotal === 0 && bookedTotal === 0) return null;

  return (
    <div className="mx-4 mt-4 mb-2 rounded-2xl border border-[hsl(var(--copper))]/30 bg-[hsl(var(--copper))]/5 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none">
            Trip total estimate
          </p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">
            ${Math.round(grandTotal / 100).toLocaleString()}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none">
            Booked so far
          </p>
          <p className="mt-1.5 text-sm font-medium tabular-nums text-[hsl(var(--emerald))]">
            ${Math.round(bookedTotal / 100).toLocaleString()}
          </p>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground leading-snug">
        Estimate updates as you delete items or lock in real bookings. Flights
        show the cheapest option until you confirm one.
      </p>
    </div>
  );
}

/** Map ItineraryItemType → Lucide icon. Replaces the old emoji glyphs
 *  for a cleaner, brand-consistent look that scales with text. */
function ItineraryItemIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const cls = cn("size-4 text-foreground/80", className);
  switch (type) {
    case "FLIGHT":
      return <Plane className={cls} />;
    case "LODGING":
    case "HOTEL":
      return <BedDouble className={cls} />;
    case "TEE_TIME":
    case "GOLF":
      return <Flag className={cls} />;
    case "DINING":
    case "MEAL":
    case "RESTAURANT":
      return <Utensils className={cls} />;
    case "TRANSPORT":
    case "CAR":
      return <Car className={cls} />;
    case "SPA":
      return <Waves className={cls} />;
    case "EXPERIENCE":
    case "ACTIVITY":
    case "FREE_TIME":
      return <Activity className={cls} />;
    case "NIGHTLIFE":
      return <Martini className={cls} />;
    default:
      return <Sparkles className={cls} />;
  }
}

/* --------------------------------------------------------------------- */
/* Category-grouped itinerary view.                                       */
/* Replaced the old day-by-day timeline on the result page so customers   */
/* see Flights → Cars → Hotel → Golf → Activities up front. The day-by-  */
/* day breakdown still exists (used by /trips/[id]/print for PDF export).*/
/* --------------------------------------------------------------------- */

type ItineraryCategoryKey =
  | "FLIGHTS"
  | "CARS"
  | "HOTEL"
  | "GOLF"
  | "ACTIVITIES";

const CATEGORY_ORDER: ItineraryCategoryKey[] = [
  "FLIGHTS",
  "CARS",
  "HOTEL",
  "GOLF",
  "ACTIVITIES",
];

const CATEGORY_META: Record<
  ItineraryCategoryKey,
  { label: string; icon: ItineraryItemType }
> = {
  FLIGHTS: { label: "Flights", icon: "FLIGHT" },
  CARS: { label: "Ground transport", icon: "TRANSPORT" },
  HOTEL: { label: "Hotel", icon: "LODGING" },
  GOLF: { label: "Golf", icon: "TEE_TIME" },
  ACTIVITIES: { label: "Activities", icon: "ACTIVITY" },
};

function categoryKeyFor(type: ItineraryItemType): ItineraryCategoryKey {
  switch (type) {
    case "FLIGHT":
      return "FLIGHTS";
    case "TRANSPORT":
      return "CARS";
    case "LODGING":
      return "HOTEL";
    case "TEE_TIME":
      return "GOLF";
    case "DINING":
    case "NIGHTLIFE":
    case "FREE_TIME":
    case "SPA":
    case "ACTIVITY":
    default:
      return "ACTIVITIES";
  }
}

function ItineraryCategoriesSection({
  tripId,
  itinerary,
}: {
  tripId: string;
  itinerary: WorkspaceItinerary;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [activeItem, setActiveItem] =
    React.useState<WorkspaceItineraryItem | null>(null);

  // Bucket every item into one of five categories, preserving chronological
  // order within each bucket so a multi-leg trip's flights read outbound
  // first → inter-leg hops → final return.
  const buckets = React.useMemo(() => {
    const out = new Map<ItineraryCategoryKey, WorkspaceItineraryItem[]>();
    for (const k of CATEGORY_ORDER) out.set(k, []);
    for (const it of itinerary.items) {
      out.get(categoryKeyFor(it.type))!.push(it);
    }
    for (const list of out.values()) {
      list.sort((a, b) => {
        if (!a.startTime && !b.startTime) return 0;
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return (
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
        );
      });
    }
    return out;
  }, [itinerary]);

  const fmtTimeOnly = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const fmtDayHeader = (iso: string | null): string => {
    if (!iso) return "Trip plan";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Trip plan";
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  };

  /** Bucket items in chronological order into runs that share a calendar day. */
  function groupByDay(items: WorkspaceItineraryItem[]): {
    dayKey: string;
    dayLabel: string;
    items: WorkspaceItineraryItem[];
  }[] {
    const out: {
      dayKey: string;
      dayLabel: string;
      items: WorkspaceItineraryItem[];
    }[] = [];
    for (const it of items) {
      const dayKey = it.startTime
        ? new Date(it.startTime).toISOString().slice(0, 10)
        : "no-date";
      const last = out[out.length - 1];
      if (last && last.dayKey === dayKey) {
        last.items.push(it);
      } else {
        out.push({
          dayKey,
          dayLabel:
            dayKey === "no-date" ? "Trip plan" : fmtDayHeader(it.startTime),
          items: [it],
        });
      }
    }
    return out;
  }

  return (
    <>
      <div className="px-4 pt-4 pb-3 space-y-6">
        <div className="flex items-center justify-between px-1">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Your trip
          </p>
          {itinerary.perPersonCost != null && itinerary.perPersonCost > 0 && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              ${Math.round(itinerary.perPersonCost / 100).toLocaleString()} pp est.
            </p>
          )}
        </div>

        {CATEGORY_ORDER.map((key) => {
          const items = buckets.get(key) ?? [];
          if (items.length === 0) return null;
          const meta = CATEGORY_META[key];
          const totalCost = items.reduce(
            (sum, it) => sum + (it.cost ?? 0),
            0,
          );
          // Day-group only kicks in once a category has 3+ items spanning
          // more than one day. Flights / cars / hotel are usually 1-2
          // items so dividers would just add noise; activities and golf
          // are where the long lists live and where the dividers pay off.
          const days = groupByDay(items);
          const shouldShowDayDividers =
            items.length >= 3 &&
            new Set(days.map((d) => d.dayKey)).size > 1;
          return (
            <section key={key} className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <span className="size-7 rounded-lg bg-[hsl(var(--copper))]/12 grid place-items-center">
                    <ItineraryItemIcon type={meta.icon} />
                  </span>
                  <p className="text-sm font-semibold tracking-tight">
                    {meta.label}
                  </p>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {items.length}
                  </span>
                </div>
                {totalCost > 0 && (
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    ${Math.round(totalCost / 100).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="space-y-3">
                {(shouldShowDayDividers ? days : [{ dayKey: "_all", dayLabel: "", items }]).map(
                  (group) => (
                    <div key={group.dayKey} className="space-y-1.5">
                      {shouldShowDayDividers && (
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/80 px-1 pt-1">
                          {group.dayLabel}
                        </p>
                      )}
                      {group.items.map((it) => {
                        const time = fmtTimeOnly(it.startTime);
                        return (
                          <button
                            key={it.id}
                            type="button"
                            onClick={() => setActiveItem(it)}
                            className="w-full text-left rounded-xl border border-border/60 bg-surface-raised/60 px-3 py-2.5 hover:border-[hsl(var(--copper))]/40 hover:bg-surface-raised transition"
                          >
                            <div className="flex items-start gap-2.5">
                              <span className="size-8 rounded-lg bg-surface-raised grid place-items-center shrink-0 mt-0.5">
                                <ItineraryItemIcon type={it.type} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <p className="text-sm font-medium leading-snug truncate">
                                    {it.title}
                                  </p>
                                  {time && (
                                    <p className="text-[11px] font-semibold tabular-nums shrink-0 text-[hsl(var(--copper))]">
                                      {time}
                                    </p>
                                  )}
                                </div>
                                {it.location && (
                                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                                    {it.location}
                                  </p>
                                )}
                                {it.description && (
                                  <p className="text-[11px] text-foreground/70 mt-1 leading-snug line-clamp-2">
                                    {it.description}
                                  </p>
                                )}
                                {it.cost != null && it.cost > 0 && (
                                  <p className="text-[10px] text-muted-foreground tabular-nums mt-1">
                                    ${Math.round(it.cost / 100).toLocaleString()}
                                  </p>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ),
                )}
              </div>
            </section>
          );
        })}

        <div className="pt-2">
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              window.open(`/trips/${tripId}/print`, "_blank", "noopener")
            }
          >
            Download day-by-day PDF
          </Button>
          <p className="text-[10px] text-muted-foreground text-center mt-1.5">
            Opens a print-ready view — pick &ldquo;Save as PDF&rdquo; in the
            browser dialog.
          </p>
        </div>
      </div>
      {activeItem && (
        <ItineraryItemDialog
          open={!!activeItem}
          onOpenChange={(o) => {
            if (!o) setActiveItem(null);
          }}
          item={activeItem}
          tripId={tripId}
          onDeleted={() => {
            setActiveItem(null);
            void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function ItineraryDaysSection({
  tripId,
  itinerary,
}: {
  tripId: string;
  itinerary: WorkspaceItinerary;
}) {
  const qc = useQueryClient();
  const [activeItem, setActiveItem] =
    React.useState<WorkspaceItineraryItem | null>(null);

  // Group by date (YYYY-MM-DD); items without a date go to "Trip plan".
  const byDay = React.useMemo(() => {
    const map = new Map<string, WorkspaceItineraryItem[]>();
    for (const it of itinerary.items) {
      const dayKey = it.startTime
        ? new Date(it.startTime).toISOString().slice(0, 10)
        : "no-date";
      const list = map.get(dayKey) ?? [];
      list.push(it);
      map.set(dayKey, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => {
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
      });
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === "no-date") return 1;
      if (b === "no-date") return -1;
      return a.localeCompare(b);
    });
  }, [itinerary]);

  const fmtDay = (key: string): string => {
    if (key === "no-date") return "Trip plan";
    const d = new Date(key);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  };

  const fmtTime = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <>
      <div className="px-4 pt-4 pb-3 space-y-4">
        <div className="flex items-center justify-between px-1">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Your trip plan
          </p>
          {itinerary.perPersonCost != null && itinerary.perPersonCost > 0 && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              ${Math.round(itinerary.perPersonCost / 100).toLocaleString()} pp est.
            </p>
          )}
        </div>
        {byDay.map(([dayKey, items]) => (
          <div key={dayKey} className="space-y-1.5">
            <p className="text-xs font-semibold text-foreground/80 px-1">
              {fmtDay(dayKey)}
            </p>
            <div className="space-y-1.5">
              {items.map((it) => {
                const time = fmtTime(it.startTime);
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setActiveItem(it)}
                    className="w-full text-left rounded-xl border border-border/60 bg-surface-raised/60 px-3 py-2.5 hover:border-[hsl(var(--copper))]/40 hover:bg-surface-raised transition"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="size-8 rounded-lg bg-surface-raised grid place-items-center shrink-0 mt-0.5">
                        <ItineraryItemIcon type={it.type} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-sm font-medium leading-snug truncate">
                            {it.title}
                          </p>
                          {time && (
                            <p className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                              {time}
                            </p>
                          )}
                        </div>
                        {it.location && (
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {it.location}
                          </p>
                        )}
                        {it.description && (
                          <p className="text-[11px] text-foreground/70 mt-1 leading-snug line-clamp-2">
                            {it.description}
                          </p>
                        )}
                        {it.cost != null && it.cost > 0 && (
                          <p className="text-[10px] text-muted-foreground tabular-nums mt-1">
                            ${Math.round(it.cost / 100).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {activeItem && (
        <ItineraryItemDialog
          open={!!activeItem}
          onOpenChange={(o) => {
            if (!o) setActiveItem(null);
          }}
          item={activeItem}
          tripId={tripId}
          onDeleted={() => {
            setActiveItem(null);
            void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
          }}
        />
      )}
    </>
  );
}

function ItineraryItemDialog({
  open,
  onOpenChange,
  item,
  tripId,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: WorkspaceItineraryItem;
  tripId: string;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = React.useState(false);
  // Full list of photo URLs from Google Places — paginate through them
  // with arrow buttons. First one is shown as the hero on open; users
  // can flick through up to 7 more without leaving the dialog.
  const [photoUrls, setPhotoUrls] = React.useState<string[]>([]);
  const [photoIndex, setPhotoIndex] = React.useState(0);
  const [photoLoading, setPhotoLoading] = React.useState(false);
  const [photoFailed, setPhotoFailed] = React.useState(false);
  const photoUrl = photoUrls[photoIndex] ?? null;
  const [swapping, setSwapping] = React.useState(false);
  const [swapApplying, setSwapApplying] = React.useState(false);

  type Alternative = {
    name: string;
    description?: string;
    location?: string;
    estimatedCostUSD?: number;
    why?: string;
  };
  const [swapAlternatives, setSwapAlternatives] = React.useState<
    Alternative[] | null
  >(null);
  const qc = useQueryClient();

  // tier === null → full 3-up "cheaper / comparable / nicer" drawer
  // tier === "cheaper" or "nicer" → single targeted suggestion from the
  // inline quick-action chips, so the user gets one focused option to
  // accept without scrolling.
  const openSwap = async (tier: "cheaper" | "nicer" | null = null) => {
    if (swapping) return;
    setSwapping(true);
    try {
      const url = tier
        ? `/api/trips/${tripId}/itinerary-items/${item.id}/swap?tier=${tier}`
        : `/api/trips/${tripId}/itinerary-items/${item.id}/swap`;
      const res = await fetch(url);
      const data = (await res.json().catch(() => null)) as {
        alternatives?: Alternative[];
        error?: string;
      } | null;
      if (!res.ok || !data?.alternatives) {
        toast.error(data?.error ?? "Couldn't fetch alternatives.");
        return;
      }
      setSwapAlternatives(data.alternatives);
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSwapping(false);
    }
  };

  const applySwap = async (alt: Alternative) => {
    if (swapApplying) return;
    setSwapApplying(true);
    try {
      const res = await fetch(
        `/api/trips/${tripId}/itinerary-items/${item.id}/swap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(alt),
        },
      );
      if (!res.ok) {
        toast.error("Couldn't apply the swap.");
        return;
      }
      toast.success(`Swapped to ${alt.name}.`);
      setSwapAlternatives(null);
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ["workspace", tripId] });
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setSwapApplying(false);
    }
  };

  // Fetch a Google Places hero photo when the dialog opens. We bias the
  // search with the location string (e.g. "Drum & Quill Pub Village of
  // Pinehurst") which usually nails the right venue even for restaurants
  // and pubs that share names. Cached for a day server-side + browser.
  React.useEffect(() => {
    if (!open) return;
    setPhotoUrls([]);
    setPhotoIndex(0);
    setPhotoFailed(false);
    // Skip photo lookup for purely logistical items where a venue photo
    // wouldn't make sense (e.g. "Drive Pinehurst → RDU + rental return").
    const skipTypes = new Set(["TRANSPORT", "CAR"]);
    if (skipTypes.has(item.type)) return;
    // Clean noisy suffixes before sending to Google Places. Lodging
    // titles like "The Prairie Club — Lodge Room (2 nights)" don't
    // match Google's hotel index because of the room-type + duration
    // tail. Strip the parenthesized "(N nights/days/rooms)" suffix and,
    // for LODGING specifically, anything after the first " — " which is
    // almost always the room class. Courses keep the full title because
    // " — Monument" is a real course identifier (Troon North).
    let query = item.title;
    if (!query) return;
    query = query.replace(/\s*\([^)]*\b(night|day|room)s?\b[^)]*\)\s*/gi, "").trim();
    if (item.type === "LODGING") {
      query = query.split(/\s+[—–-]\s+/)[0].trim();
    }
    const loc = item.location ?? "";
    setPhotoLoading(true);
    const params = new URLSearchParams({ q: query });
    if (loc) params.set("loc", loc);
    fetch(`/api/places/photo?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        const urls = Array.isArray(data?.photoUrls)
          ? (data.photoUrls as string[])
          : data?.photoUrl
            ? [data.photoUrl as string]
            : [];
        if (urls.length > 0) setPhotoUrls(urls);
        else setPhotoFailed(true);
      })
      .catch(() => setPhotoFailed(true))
      .finally(() => setPhotoLoading(false));
  }, [open, item.title, item.location, item.type]);

  const startTime = item.startTime ? new Date(item.startTime) : null;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const deleteItem = async () => {
    if (deleting) return;
    if (
      !confirm(
        `Remove "${item.title}" from the trip? This also cancels any booking tied to it.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/trips/${tripId}/itinerary-items/${item.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        toast.error("Couldn't delete that item.");
        return;
      }
      toast.success("Removed from your trip.");
      onDeleted();
    } catch {
      toast.error("Network error — try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        {/* Hero photo from Google Places — only renders when we got
            one back. Skeleton while loading; nothing if the place
            didn't match or photos are disabled. */}
        {photoLoading && (
          <div className="aspect-[16/9] bg-surface-raised animate-pulse" />
        )}
        {!photoLoading && photoUrl && !photoFailed && (
          <div className="relative aspect-[16/9] bg-surface-raised overflow-hidden group/photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoUrl}
              alt={item.title}
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setPhotoFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background/40 to-transparent pointer-events-none" />
            {/* Carousel controls — only render when more than one photo
                came back. Arrows slide in on hover (desktop) and always
                stay visible on touch. Counter pill bottom-right gives
                people a sense of how many shots there are without
                having to click through. */}
            {photoUrls.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Previous photo"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPhotoIndex(
                      (i) => (i - 1 + photoUrls.length) % photoUrls.length,
                    );
                  }}
                  className="absolute left-2 top-1/2 -translate-y-1/2 size-9 rounded-full bg-black/45 hover:bg-black/65 text-white grid place-items-center backdrop-blur-sm transition opacity-80 hover:opacity-100"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next photo"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPhotoIndex((i) => (i + 1) % photoUrls.length);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-9 rounded-full bg-black/45 hover:bg-black/65 text-white grid place-items-center backdrop-blur-sm transition opacity-80 hover:opacity-100"
                >
                  <ChevronRight className="size-5" />
                </button>
                <div className="absolute bottom-2 right-2 rounded-full bg-black/55 text-white text-[10px] font-medium tabular-nums px-2 py-0.5 backdrop-blur-sm">
                  {photoIndex + 1} / {photoUrls.length}
                </div>
              </>
            )}
          </div>
        )}
        {/* Fallback when Google had no photo for this venue. Subtle
            placeholder beats an awkward gap or — worse — a dialog that
            silently has no hero at all. */}
        {!photoLoading && (photoFailed || !photoUrl) && (
          <div className="relative aspect-[16/9] bg-gradient-to-br from-[hsl(var(--navy))]/10 to-[hsl(var(--copper))]/10 grid place-items-center">
            <ItineraryItemIcon
              type={item.type}
              className="size-10 text-muted-foreground/50"
            />
          </div>
        )}

        <header className="px-6 py-4 border-b border-border/50 bg-[hsl(var(--navy))]/5">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-surface-raised grid place-items-center shrink-0">
              <ItineraryItemIcon type={item.type} className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1">
                {item.type}
                {item.confirmationState === "CONFIRMED" && (
                  <span className="ml-2 text-[hsl(var(--emerald))]">
                    · Booked
                  </span>
                )}
              </p>
              {/* Title was truncating mid-word on long item names
                  ("Downtime — pool, Seven Falls, or Garden of the Go…").
                  Let it wrap to 3 lines instead so customers can actually
                  read what the AI suggested. */}
              <DialogTitle className="text-base font-semibold leading-tight line-clamp-3">
                {item.title}
              </DialogTitle>
            </div>
          </div>
        </header>

        <div className="px-6 py-5 space-y-4">
          {(item.location || startTime) && (
            <div className="text-sm space-y-1">
              {startTime && (
                <p className="text-foreground/80">
                  {fmtDate(startTime)} · {fmtTime(startTime)}
                </p>
              )}
              {item.location && (
                <p className="text-muted-foreground">{item.location}</p>
              )}
            </div>
          )}
          {item.description && (
            <p className="text-sm text-foreground/80 leading-relaxed">
              {item.description}
            </p>
          )}
          {item.type === "TRANSPORT" && (() => {
            // MVP: deep-link into the Uber app for any TRANSPORT item.
            // Once the Central API key lands we'll swap this for in-app
            // booking; until then the customer confirms + pays through
            // Uber directly. The link opens m.uber.com which redirects
            // into the app if installed, falls back to web otherwise.
            const url = buildUberDeepLink({
              dropoffName: item.title,
              dropoffAddress: item.location,
            });
            if (!url) return null;
            return (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-2xl bg-black text-white text-sm font-semibold px-4 py-3 hover:bg-neutral-800 transition"
              >
                <Car className="size-4" />
                Ride with Uber
              </a>
            );
          })()}
          {item.aiRationale && (
            <div className="rounded-xl border border-border/60 bg-surface-raised/50 px-4 py-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                Why this pick
              </p>
              <p className="text-xs text-foreground/80 leading-relaxed">
                {item.aiRationale}
              </p>
            </div>
          )}
          {item.cost != null && item.cost > 0 && (
            <div className="pt-2 border-t border-border/40 space-y-2">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">Cost</span>
                <span className="font-semibold tabular-nums">
                  ${Math.round(item.cost / 100).toLocaleString()}
                </span>
              </div>
              {/* Inline rate-adjustment chips — single tap returns one
                  cheaper or one nicer option (versus the full 3-up
                  alternatives drawer). The result lands in the same
                  swap drawer below, so the user previews + accepts
                  rather than auto-swapping unexpectedly. */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openSwap("cheaper")}
                  disabled={swapping}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full border border-[hsl(var(--emerald))]/30 bg-[hsl(var(--emerald))]/5 hover:bg-[hsl(var(--emerald))]/10 text-[hsl(var(--emerald))] text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                >
                  <ArrowDown className="size-3" />
                  Cheaper rate
                </button>
                <button
                  type="button"
                  onClick={() => openSwap("nicer")}
                  disabled={swapping}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full border border-[hsl(var(--copper))]/30 bg-[hsl(var(--copper))]/5 hover:bg-[hsl(var(--copper))]/10 text-[hsl(var(--copper))] text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                >
                  <ArrowUp className="size-3" />
                  Nicer rate
                </button>
              </div>
            </div>
          )}

          <section className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={deleting || swapping}
              className="shrink-0"
            >
              Close
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => openSwap(null)}
                disabled={deleting || swapping}
                className="shrink-0 whitespace-nowrap"
              >
                {swapping ? (
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                ) : null}
                Find alternative
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={deleteItem}
                disabled={deleting || swapping}
                className="shrink-0 whitespace-nowrap text-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))]/10 border-[hsl(var(--destructive))]/30"
              >
                {deleting ? (
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3 mr-1.5" />
                )}
                Remove
              </Button>
            </div>
          </section>
          {swapAlternatives && (
            <section className="rounded-2xl border border-[hsl(var(--copper))]/30 bg-[hsl(var(--copper))]/5 p-4 space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Pick an alternative
              </p>
              {swapAlternatives.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No alternatives came back — try again or use Remove.
                </p>
              )}
              {swapAlternatives.map((alt, i) => {
                // The 3-up endpoint returns alternatives in a fixed
                // order: 0 = cheaper, 1 = comparable, 2 = nicer. When
                // only a single alternative came back (the inline
                // Cheaper / Nicer chips), derive the label from the
                // price delta vs. the current item instead so the badge
                // reflects what was actually requested.
                const currentCostUSD = item.cost
                  ? Math.round(item.cost / 100)
                  : null;
                let tierLabel: { text: string; tone: string };
                if (swapAlternatives.length === 1 && currentCostUSD && alt.estimatedCostUSD != null) {
                  tierLabel =
                    alt.estimatedCostUSD < currentCostUSD
                      ? { text: "Cheaper", tone: "text-[hsl(var(--emerald))] border-[hsl(var(--emerald))]/30" }
                      : { text: "Nicer", tone: "text-[hsl(var(--copper))] border-[hsl(var(--copper))]/40" };
                } else {
                  tierLabel =
                    i === 0
                      ? { text: "Cheaper", tone: "text-[hsl(var(--emerald))] border-[hsl(var(--emerald))]/30" }
                      : i === 1
                        ? { text: "Comparable", tone: "text-muted-foreground border-border" }
                        : { text: "Nicer", tone: "text-[hsl(var(--copper))] border-[hsl(var(--copper))]/40" };
                }
                return (
                <button
                  key={i}
                  type="button"
                  onClick={() => applySwap(alt)}
                  disabled={swapApplying}
                  className="w-full text-left rounded-xl border border-border/60 bg-surface-raised/70 p-3 hover:border-[hsl(var(--copper))]/50 hover:bg-surface-raised transition disabled:opacity-50"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`text-[9px] uppercase tracking-widest border rounded-full px-1.5 py-0.5 leading-none shrink-0 ${tierLabel.tone}`}
                      >
                        {tierLabel.text}
                      </span>
                      <p className="font-semibold text-sm leading-snug truncate">
                        {alt.name}
                      </p>
                    </div>
                    {alt.estimatedCostUSD != null && (
                      <p className="text-xs font-medium tabular-nums shrink-0">
                        ${alt.estimatedCostUSD.toLocaleString()}
                      </p>
                    )}
                  </div>
                  {alt.location && (
                    <p className="text-[11px] text-muted-foreground truncate">
                      {alt.location}
                    </p>
                  )}
                  <p className="text-[11px] text-foreground/75 mt-1 leading-snug">
                    {alt.why ?? alt.description}
                  </p>
                </button>
                );
              })}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSwapAlternatives(null)}
                className="w-full mt-1"
              >
                Cancel swap
              </Button>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChecklistEmpty() {
  return (
    <div className="px-5 py-10 text-center">
      <div className="mx-auto size-10 rounded-2xl border border-[hsl(var(--copper)/0.3)] bg-[hsl(var(--copper)/0.06)] grid place-items-center text-[hsl(var(--copper))]">
        <Sparkles className="size-4" />
      </div>
      <p className="mt-4 text-sm text-muted-foreground max-w-[24ch] mx-auto leading-relaxed">
        Bookings appear here as the concierge locks them in.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function CartFooter({
  tripId,
  bookings,
}: {
  tripId: string;
  bookings: WorkspaceBooking[];
}) {
  const [submitting, setSubmitting] = React.useState(false);

  // Only charge for bookings that are pay-now (flights, sometimes
  // transport). Hotels / golf / dinners settle at the property and
  // MUST NOT be on this total — Pyltrix never runs the customer's
  // card for those.
  const payNow = bookings.filter(
    (b) =>
      !b.paidAt && (b.cost ?? 0) > 0 && b.paymentMode === "pay_now",
  );
  const payAtVenue = bookings.filter(
    (b) => (b.cost ?? 0) > 0 && b.paymentMode === "pay_at_property",
  );
  const total = payNow.reduce((sum, b) => sum + (b.cost ?? 0), 0);
  const venueTotal = payAtVenue.reduce((sum, b) => sum + (b.cost ?? 0), 0);

  if (payNow.length === 0 && payAtVenue.length === 0) return null;

  const onPay = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/checkout/cart`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error ?? "Couldn't start checkout.");
        return;
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Checkout request failed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border/60 bg-surface/80 backdrop-blur-xl px-5 py-3.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Due now
          </p>
          <p className="text-display text-lg num-tabular leading-tight">
            {formatCurrency(total / 100)}
          </p>
        </div>
        {payNow.length > 0 ? (
          <Button
            variant="navy"
            size="sm"
            onClick={onPay}
            disabled={submitting}
            className="shrink-0"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Starting…
              </>
            ) : (
              <>Pay {formatCurrency(total / 100)}</>
            )}
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            Nothing to charge upfront
          </span>
        )}
      </div>
      {payAtVenue.length > 0 && (
        <p className="text-[11px] text-muted-foreground leading-snug">
          <span className="font-medium text-foreground/80">
            {formatCurrency(venueTotal / 100)}
          </span>{" "}
          settles at the property ({payAtVenue.length}{" "}
          {payAtVenue.length === 1 ? "reservation" : "reservations"} —
          hotels, courses, dining typically charge at check-in or when
          you dine).
        </p>
      )}
    </div>
  );
}
