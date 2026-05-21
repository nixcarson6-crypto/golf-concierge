"use client";

import * as React from "react";
import {
  CalendarRange,
  CircleDollarSign,
  Compass,
  Loader2,
  Sparkles,
  Plane,
  BedDouble,
  Flag,
  Car,
  Utensils,
  ChevronDown,
  Copy,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { cn, formatCurrency, formatDateRange } from "@/lib/utils";
import { airlineVerifyUrl } from "@/lib/ai/chat-cards";
import type {
  WorkspaceBooking,
  WorkspaceItinerary,
  WorkspaceTrip,
} from "./workspace";

export function LivePreview({
  tripId,
  trip,
  itinerary,
  bookings = [],
}: {
  tripId: string;
  trip: WorkspaceTrip;
  itinerary: WorkspaceItinerary | null;
  bookings?: WorkspaceBooking[];
}) {
  // "Empty" = nothing the concierge has extracted yet. We surface a
  // gentler prompt instead of the static "Destination forming…" which
  // reads as if work is in progress when really we're waiting on input.
  const isEmpty =
    !trip.destination &&
    !trip.startDate &&
    !trip.groupSize &&
    !trip.budgetTotal &&
    !trip.budgetPerPerson &&
    !itinerary;

  return (
    <div className="h-full flex flex-col rounded-3xl glass overflow-hidden">
      <header className="px-5 py-4 border-b border-border/60">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Live trip
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <h2 className="text-display text-xl tracking-tight truncate">
            {trip.destination ??
              (isEmpty ? "Waiting on details" : "Destination forming…")}
          </h2>
          {itinerary && (
            <Badge variant="navy" size="sm">
              v{itinerary.version}
            </Badge>
          )}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <MetricChip
            icon={<CalendarRange className="size-3.5" />}
            label="Dates"
            value={
              trip.startDate
                ? formatDateRange(
                    new Date(trip.startDate),
                    trip.endDate ? new Date(trip.endDate) : null,
                  )
                : "TBD"
            }
          />
          <MetricChip
            icon={<Compass className="size-3.5" />}
            label="Group"
            value={trip.groupSize ? `${trip.groupSize} players` : "TBD"}
          />
          <MetricChip
            icon={<CircleDollarSign className="size-3.5" />}
            label="Per person"
            value={
              itinerary?.perPersonCost
                ? formatCurrency(itinerary.perPersonCost / 100)
                : trip.budgetPerPerson
                  ? formatCurrency(trip.budgetPerPerson / 100)
                  : "TBD"
            }
          />
        </div>
      </header>

      <ScrollArea className="flex-1">
        {!itinerary && bookings.length === 0 ? (
          <PreviewEmpty />
        ) : (
          <div className="px-5 py-5 space-y-3">
            {itinerary?.aiSummary && (
              <div className="rounded-2xl border border-border/70 bg-surface-raised/50 px-4 py-3.5">
                <div className="flex items-start gap-2.5">
                  <Sparkles className="size-3.5 text-[hsl(var(--copper))] mt-0.5 shrink-0" />
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {itinerary.aiSummary}
                  </p>
                </div>
              </div>
            )}
            {itinerary?.changes && itinerary.changes.length > 0 && (
              <div className="rounded-2xl border border-[hsl(var(--navy)/0.2)] bg-[hsl(var(--navy)/0.04)] px-4 py-3 text-xs space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-[hsl(var(--navy))]">
                  What changed in v{itinerary.version}
                </p>
                {itinerary.changes.map((c, i) => (
                  <p key={i} className="text-muted-foreground leading-relaxed">
                    · {c}
                  </p>
                ))}
              </div>
            )}
            {bookings.length > 0 && (
              <BookingsSection bookings={bookings} />
            )}
            {itinerary?.items.map((item) => (
              <ItineraryItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </ScrollArea>
      <CartFooter tripId={tripId} bookings={bookings} />
    </div>
  );
}

function BookingsSection({ bookings }: { bookings: WorkspaceBooking[] }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-1">
        Bookings · {bookings.length}
      </p>
      <div className="space-y-1.5">
        {bookings.map((b) => (
          <BookingRow key={b.id} booking={b} />
        ))}
      </div>
    </div>
  );
}

function BookingRow({ booking }: { booking: WorkspaceBooking }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const Icon =
    booking.type === "FLIGHT"
      ? Plane
      : booking.type === "LODGING"
        ? BedDouble
        : booking.type === "TEE_TIME"
          ? Flag
          : booking.type === "TRANSPORT"
            ? Car
            : Utensils;

  const verify =
    booking.type === "FLIGHT" && booking.confirmationCode && !booking.isStub
      ? airlineVerifyUrl(
          booking.vendor ?? booking.title,
          booking.airlineCode,
          booking.leadLastName,
          booking.confirmationCode,
        )
      : null;

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

  const canExpand =
    Boolean(booking.confirmationCode) ||
    Boolean(booking.summary) ||
    (booking.partyNames && booking.partyNames.length > 0);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-card/60 transition",
        booking.isStub
          ? "border-[hsl(var(--copper))]/40"
          : "border-border/70 hover:border-foreground/15",
      )}
    >
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 text-left",
          canExpand && "cursor-pointer",
        )}
        aria-expanded={open}
      >
        <div className="size-9 rounded-xl bg-surface-raised grid place-items-center text-foreground shrink-0">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none">
            {booking.vendor ?? booking.title}
          </p>
          <h3 className="text-sm font-medium leading-tight mt-1 truncate">
            {booking.summary ?? booking.title}
          </h3>
        </div>
        <div className="text-right shrink-0 flex items-center gap-2">
          <div>
            {booking.cost != null && (
              <p className="text-sm font-semibold tabular-nums leading-none">
                {formatCurrency(booking.cost / 100)}
              </p>
            )}
            <p className="text-[10px] mt-1 leading-none">
              {booking.isStub ? (
                <span className="text-[hsl(var(--copper))]">Pencilled</span>
              ) : (
                <span className="text-[hsl(var(--emerald))]">Confirmed</span>
              )}
            </p>
          </div>
          {canExpand && (
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition",
                open && "rotate-180",
              )}
            />
          )}
        </div>
      </button>

      {open && canExpand && (
        <div className="px-4 pb-3.5 pt-1 space-y-2.5 border-t border-border/40">
          {booking.confirmationCode && (
            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1">
                  Confirmation
                </p>
                <button
                  type="button"
                  onClick={copyRef}
                  className="inline-flex items-center gap-1.5 text-sm font-mono font-semibold tabular-nums hover:text-[hsl(var(--copper))] transition"
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
              </div>
              {verify && (
                <a
                  href={verify.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border border-border bg-surface-raised hover:bg-surface-raised/80 hover:border-foreground/30 transition shrink-0"
                >
                  {verify.label}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
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

          {booking.contactEmail && !booking.isStub && (
            <p className="text-[10px] text-muted-foreground">
              Confirmation will be emailed to {booking.contactEmail}
            </p>
          )}
          {booking.isStub && (
            <p className="text-[10px] text-[hsl(var(--copper))]/90">
              Pencilled in — we&apos;ll lock this with the partner once API access lands.
            </p>
          )}
        </div>
      )}
    </article>
  );
}

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
    <div className="border-t border-border/60 bg-surface/80 backdrop-blur-xl px-5 py-3 space-y-2.5">
      <div className="space-y-1">
        {unpaid.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span className="truncate text-muted-foreground">
              {b.title}
              {b.isStub && (
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[hsl(var(--copper))]">
                  pencilled
                </span>
              )}
            </span>
            <span className="num-tabular shrink-0">
              {b.cost ? formatCurrency(b.cost / 100) : "—"}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/40">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Total
          </p>
          <p className="text-display text-lg num-tabular">
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
    </div>
  );
}

function MetricChip({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface-raised/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 num-tabular text-sm truncate">{value}</p>
    </div>
  );
}

function PreviewEmpty() {
  return (
    <div className="h-full grid place-items-center px-8 py-16 text-center">
      <div>
        <div className="mx-auto size-12 rounded-2xl border border-[hsl(var(--copper)/0.3)] bg-[hsl(var(--copper)/0.06)] grid place-items-center text-[hsl(var(--copper))]">
          <Sparkles className="size-5" />
        </div>
        <p className="mt-5 text-display text-lg tracking-tight">
          Your trip will take shape here.
        </p>
        <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
          Tell the concierge a destination, dates, group size, and budget — this
          panel fills in as you go.
        </p>
      </div>
    </div>
  );
}
