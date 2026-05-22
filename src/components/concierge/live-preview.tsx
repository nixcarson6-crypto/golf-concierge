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
  Copy,
  CheckCircle2,
  Trash2,
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
          <ItineraryDaysSection tripId={tripId} itinerary={itinerary} />
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
      <CartFooter tripId={tripId} bookings={bookings} />
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
  glyph?: string;
}> = [
  { id: "cheaper", label: "Cheaper", glyph: "💰" },
  { id: "nonstop", label: "Nonstop only", glyph: "✈️" },
  { id: "earlier", label: "Earlier", glyph: "🌅" },
  { id: "later", label: "Later", glyph: "🌆" },
  { id: "different_airline", label: "Different airline", glyph: "🔄" },
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

  // Auto-open the booking modal when the user just landed here from
  // the quiz (?autoBook=1). The "best fit" offer (first in the list)
  // is pre-selected; for users with a complete saved profile this is
  // effectively a one-click confirm. We strip the query param right
  // after so a refresh doesn't re-trigger.
  React.useEffect(() => {
    if (searchParams?.get("autoBook") !== "1") return;
    if (bookingOffer || activeOffer) return;
    if (!suggested.offers.length) return;
    setBookingOffer(suggested.offers[0]);
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
                {chip.glyph && <span>{chip.glyph}</span>}
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
    case "HOTEL":
      return <BedDouble className={cls} />;
    case "GOLF":
      return <Flag className={cls} />;
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
      return <Activity className={cls} />;
    case "NIGHTLIFE":
      return <Martini className={cls} />;
    default:
      return <Sparkles className={cls} />;
  }
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
          {itinerary.perPersonCost != null && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              ${Math.round(itinerary.perPersonCost).toLocaleString()} pp est.
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
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [photoLoading, setPhotoLoading] = React.useState(false);
  const [photoFailed, setPhotoFailed] = React.useState(false);

  // Fetch a Google Places hero photo when the dialog opens. We bias the
  // search with the location string (e.g. "Drum & Quill Pub Village of
  // Pinehurst") which usually nails the right venue even for restaurants
  // and pubs that share names. Cached for a day server-side + browser.
  React.useEffect(() => {
    if (!open) return;
    setPhotoUrl(null);
    setPhotoFailed(false);
    // Skip photo lookup for purely logistical items where a venue photo
    // wouldn't make sense (e.g. "Drive Pinehurst → RDU + rental return").
    const skipTypes = new Set(["TRANSPORT", "CAR"]);
    if (skipTypes.has(item.type)) return;
    const query = item.title;
    if (!query) return;
    const loc = item.location ?? "";
    setPhotoLoading(true);
    const params = new URLSearchParams({ q: query });
    if (loc) params.set("loc", loc);
    fetch(`/api/places/photo?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.photoUrl) setPhotoUrl(data.photoUrl as string);
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
          <div className="relative aspect-[16/9] bg-surface-raised overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoUrl}
              alt={item.title}
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setPhotoFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background/40 to-transparent pointer-events-none" />
          </div>
        )}

        <header className="px-6 py-4 border-b border-border/50 bg-[hsl(var(--navy))]/5">
          <div className="flex items-center gap-3">
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
              <DialogTitle className="text-base font-semibold leading-tight truncate">
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
            <div className="flex items-baseline justify-between text-sm pt-2 border-t border-border/40">
              <span className="text-muted-foreground">Cost</span>
              <span className="font-semibold tabular-nums">
                ${Math.round(item.cost / 100).toLocaleString()}
              </span>
            </div>
          )}

          <section className="flex items-center justify-between gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={deleting}
            >
              Close
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={deleteItem}
              disabled={deleting}
              className="text-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))]/10 border-[hsl(var(--destructive))]/30"
            >
              {deleting ? (
                <Loader2 className="size-3 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="size-3 mr-1.5" />
              )}
              Remove from trip
            </Button>
          </section>
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

  const unpaid = bookings.filter((b) => !b.paidAt && (b.cost ?? 0) > 0);
  const total = unpaid.reduce((sum, b) => sum + (b.cost ?? 0), 0);

  if (unpaid.length === 0) return null;

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
    <div className="border-t border-border/60 bg-surface/80 backdrop-blur-xl px-5 py-3.5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Total due
        </p>
        <p className="text-display text-lg num-tabular leading-tight">
          {formatCurrency(total / 100)}
        </p>
      </div>
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
    </div>
  );
}
