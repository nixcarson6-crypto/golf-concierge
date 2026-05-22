"use client";

import * as React from "react";
import { Plane, Clock, ExternalLink, Luggage } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SuggestedFlightOffer } from "./workspace";

/**
 * Full itinerary view for a suggested (not-yet-booked) Duffel offer.
 * Opens when the user clicks one of the cards in the Live Trip side
 * panel. Shows every segment, every layover, full pricing breakdown,
 * and a "Book this" CTA that hands off to the chat to collect
 * passenger details and ticket the offer.
 *
 * Booking flow note: we deliberately route through the chat for the
 * passenger-details collection (name, DOB, email, phone) for now —
 * that UX already exists and works. A dedicated booking form lives
 * next on the roadmap; this dialog is the see-the-itinerary win.
 */
export function SuggestedFlightDialog({
  open,
  onOpenChange,
  offer,
  passengers,
  cabin,
  onBookRequested,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: SuggestedFlightOffer;
  passengers: number;
  cabin: string;
  /** Called when the user clicks "Book this". */
  onBookRequested: (offer: SuggestedFlightOffer) => void;
}) {
  const total = Math.round(offer.totalAmount / 100);
  const perPax = Math.round(offer.perPassengerAmount / 100);
  const expires = offer.expiresAt ? new Date(offer.expiresAt) : null;
  const minutesLeft = expires
    ? Math.max(0, Math.round((expires.getTime() - Date.now()) / 60_000))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <header className="px-6 py-5 border-b border-border/50 bg-[hsl(var(--navy))]/5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-10 rounded-xl bg-surface-raised grid place-items-center text-foreground shrink-0">
                <Plane className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1">
                  Live offer · {cabin.replace("_", " ")}
                </p>
                <DialogTitle className="text-base font-semibold leading-tight truncate">
                  {offer.airlineName}
                </DialogTitle>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-base font-semibold tabular-nums">
                ${total.toLocaleString()}
              </p>
              <p className="text-[10px] text-muted-foreground">
                total · {passengers} {passengers === 1 ? "pax" : "pax"}
              </p>
            </div>
          </div>
        </header>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Per-leg detail */}
          <section className="space-y-4">
            {offer.slices.map((slice, i) => (
              <SliceDetail
                key={i}
                slice={slice}
                label={i === 0 ? "Outbound" : i === 1 ? "Return" : `Leg ${i + 1}`}
              />
            ))}
          </section>

          {/* Pricing breakdown */}
          <section className="rounded-2xl border border-border/60 bg-surface-raised/50 px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Per traveller</span>
              <span className="tabular-nums font-medium">
                ${perPax.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                × {passengers} {passengers === 1 ? "traveller" : "travellers"}
              </span>
              <span className="tabular-nums">
                ${total.toLocaleString()}
              </span>
            </div>
            <div className="pt-1.5 mt-1.5 border-t border-border/60 flex items-center justify-between">
              <span className="font-semibold">Total fare</span>
              <span className="text-base font-semibold tabular-nums">
                ${total.toLocaleString()} {offer.currency}
              </span>
            </div>
          </section>

          {/* Baggage / notes (Duffel doesn't surface this on the offer summary
              by default — we show a generic note so customers aren't surprised
              by checked-bag costs later). */}
          <section className="text-xs text-muted-foreground space-y-1.5 pt-1">
            <p className="flex items-start gap-2">
              <Luggage className="size-3 mt-0.5 shrink-0" />
              <span>
                One carry-on included. Checked bag fees vary by fare class
                and may apply at booking. Cabin: <strong className="text-foreground">{cabin.replace("_", " ")}</strong>.
              </span>
            </p>
            {minutesLeft !== null && (
              <p className="flex items-start gap-2">
                <Clock className="size-3 mt-0.5 shrink-0" />
                <span>
                  Fare locked for ~{minutesLeft} more{" "}
                  {minutesLeft === 1 ? "minute" : "minutes"}. Duffel offers
                  expire fast — if it lapses we'll re-pull a fresh equivalent.
                </span>
              </p>
            )}
          </section>

          {/* Actions */}
          <section className="flex items-center justify-between gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onBookRequested(offer);
                onOpenChange(false);
              }}
              className="bg-[hsl(var(--copper))] text-white hover:bg-[hsl(var(--copper))]/90"
            >
              Book this flight
              <ExternalLink className="size-3 ml-1.5" />
            </Button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SliceDetail({
  slice,
  label,
}: {
  slice: SuggestedFlightOffer["slices"][number];
  label: string;
}) {
  const depDate = new Date(slice.departing);
  const arrDate = new Date(slice.arriving);
  const sameDay = depDate.toDateString() === arrDate.toDateString();
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtDate = (d: Date) =>
    d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const fmtDuration = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm.toString().padStart(2, "0")}m`;
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-surface-raised/40 p-4">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
        <span>{label}</span>
        <span>{fmtDate(depDate)}</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="min-w-0">
          <p className="text-2xl font-semibold tabular-nums leading-none">
            {slice.origin}
          </p>
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {fmtTime(depDate)}
          </p>
        </div>
        <div className="flex-1 flex flex-col items-center min-w-0">
          <p className="text-[10px] text-muted-foreground tabular-nums mb-1">
            {fmtDuration(slice.durationMinutes)}
          </p>
          <div className="w-full h-px bg-border relative">
            {slice.stops > 0 && (
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-[10px] text-[hsl(var(--copper))] font-medium">
                {slice.stops} stop{slice.stops > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {slice.stops === 0 ? "Nonstop" : "Connecting"}
          </p>
        </div>
        <div className="text-right min-w-0">
          <p className="text-2xl font-semibold tabular-nums leading-none">
            {slice.destination}
          </p>
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {fmtTime(arrDate)}
            {!sameDay && "*"}
          </p>
        </div>
      </div>

      {/* Per-segment detail (shows the actual airline-operated legs incl.
          layover airport when there's a stop). */}
      {slice.segments && slice.segments.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/40 space-y-2">
          {slice.segments.map((seg, idx) => {
            const sDep = new Date(seg.departing);
            const sArr = new Date(seg.arriving);
            return (
              <div
                key={idx}
                className="text-xs text-foreground/80 flex items-center gap-2 leading-snug"
              >
                <span className="font-mono font-semibold text-foreground">
                  {seg.flightNumber}
                </span>
                <span className="text-muted-foreground/70">·</span>
                <span className="tabular-nums">{seg.origin}</span>
                <span className="text-muted-foreground/70 tabular-nums">
                  {fmtTime(sDep)}
                </span>
                <span className="text-muted-foreground/40">→</span>
                <span className="tabular-nums">{seg.destination}</span>
                <span className="text-muted-foreground/70 tabular-nums">
                  {fmtTime(sArr)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!sameDay && (
        <p
          className={cn(
            "mt-3 text-[10px] text-muted-foreground",
            "border-t border-border/40 pt-2",
          )}
        >
          * Arrives {fmtDate(arrDate)} (next day)
        </p>
      )}
    </div>
  );
}
