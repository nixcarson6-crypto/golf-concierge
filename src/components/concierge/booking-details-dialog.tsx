"use client";

import * as React from "react";
import {
  Plane,
  Clock,
  Copy,
  CheckCircle2,
  ExternalLink,
  TestTube,
  ShieldCheck,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency } from "@/lib/utils";
import { airlineVerifyUrl } from "@/lib/ai/chat-cards";
import type { WorkspaceBooking, WorkspaceBookedSlice } from "./workspace";

/**
 * In-app booking detail view. This is the "see my flight" experience —
 * customers shouldn't have to leave Pyltrix to read their booking. For
 * sandbox bookings (where the airline's manage-trip page won't recognise
 * the PNR), this is the only credible way to show proof.
 */
export function BookingDetailsDialog({
  open,
  onOpenChange,
  booking,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking: WorkspaceBooking;
}) {
  const [copied, setCopied] = React.useState(false);

  const copyRef = async () => {
    if (!booking.confirmationCode) return;
    try {
      await navigator.clipboard.writeText(booking.confirmationCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      /* clipboard might be blocked */
    }
  };

  const verify = booking.confirmationCode
    ? airlineVerifyUrl(
        booking.vendor ?? booking.title,
        booking.airlineCode,
        booking.leadLastName,
        booking.confirmationCode,
        { sandbox: booking.isSandbox },
      )
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <header
          className={cn(
            "px-6 py-5 border-b border-border/50",
            booking.isSandbox
              ? "bg-[hsl(var(--copper))]/8"
              : "bg-[hsl(var(--emerald))]/8",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-10 rounded-xl bg-surface-raised grid place-items-center text-foreground shrink-0">
                <Plane className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground leading-none mb-1 flex items-center gap-1.5">
                  {booking.isSandbox ? (
                    <>
                      <TestTube className="size-3 text-[hsl(var(--copper))]" />
                      Sandbox booking
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="size-3 text-[hsl(var(--emerald))]" />
                      Confirmed
                    </>
                  )}
                </p>
                <DialogTitle className="text-base font-semibold leading-tight truncate">
                  {booking.vendor ?? booking.title}
                </DialogTitle>
              </div>
            </div>
            {booking.cost != null && (
              <div className="text-right shrink-0">
                <p className="text-base font-semibold tabular-nums">
                  {formatCurrency(booking.cost / 100)}
                </p>
                <p className="text-[10px] text-muted-foreground">total</p>
              </div>
            )}
          </div>
        </header>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Confirmation number — the trust signal */}
          <section>
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
              Confirmation
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyRef}
                className="text-2xl font-mono font-bold tabular-nums tracking-wide hover:text-[hsl(var(--copper))] transition inline-flex items-center gap-2"
                title="Copy confirmation"
              >
                {booking.confirmationCode ?? "—"}
                <Copy className="size-4 opacity-60" />
              </button>
              {copied && (
                <span className="text-xs text-[hsl(var(--emerald))] inline-flex items-center gap-1">
                  <CheckCircle2 className="size-3" /> Copied
                </span>
              )}
            </div>
          </section>

          {/* Flight slices — the actual flight detail */}
          {booking.bookedSlices && booking.bookedSlices.length > 0 && (
            <section className="space-y-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Itinerary
              </p>
              {booking.bookedSlices.map((s, i) => (
                <SliceRow key={i} slice={s} />
              ))}
            </section>
          )}

          {/* Passenger list */}
          {booking.partyNames && booking.partyNames.length > 0 && (
            <section>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                Passengers
              </p>
              <ul className="space-y-1">
                {booking.partyNames.map((n, i) => (
                  <li
                    key={i}
                    className="text-sm flex items-center gap-2 text-foreground/90"
                  >
                    <span className="size-1.5 rounded-full bg-[hsl(var(--navy))]" />
                    {n}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Meta lines */}
          <section className="text-xs text-muted-foreground space-y-1 pt-2 border-t border-border/40">
            {booking.confirmedAt && (
              <p>Booked {new Date(booking.confirmedAt).toLocaleString()}</p>
            )}
            {booking.contactEmail && (
              <p>Confirmation emailed to {booking.contactEmail}</p>
            )}
            {booking.providerReference && (
              <p className="font-mono">Provider ref: {booking.providerReference}</p>
            )}
          </section>

          {/* Sandbox disclaimer */}
          {booking.isSandbox && (
            <section className="rounded-xl border border-[hsl(var(--copper))]/40 bg-[hsl(var(--copper))]/10 px-4 py-3 text-xs text-foreground/80 space-y-1.5">
              <p className="font-medium text-[hsl(var(--copper))] inline-flex items-center gap-1.5">
                <TestTube className="size-3" />
                This is a test booking
              </p>
              <p className="leading-relaxed">
                The PNR is a Duffel sandbox confirmation issued for
                development — the airline doesn&apos;t have a real reservation
                for it. Once Pyltrix flips to a live Duffel key, every
                booking becomes a genuine ticket that shows up in the
                airline&apos;s manage-trip portal and on the customer&apos;s
                boarding pass.
              </p>
            </section>
          )}

          {/* Actions */}
          <section className="flex items-center justify-between gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            {verify && (
              <a
                href={verify.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border bg-surface-raised hover:bg-surface-raised/80 hover:border-foreground/30 transition"
                title="Opens the airline's manage-trip page. Your confirmation number has been copied to your clipboard — paste it there to pull up the booking."
              >
                {verify.label}
                <ExternalLink className="size-3" />
              </a>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SliceRow({ slice }: { slice: WorkspaceBookedSlice }) {
  const dep = parseISO(slice.departing);
  const arr = parseISO(slice.arriving);
  const sameDay = dep && arr && dep.toDateString() === arr.toDateString();

  return (
    <div className="rounded-xl border border-border/60 bg-surface-raised/50 px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {slice.flightNumber && (
            <span className="font-mono font-semibold text-foreground">
              {slice.flightNumber}
            </span>
          )}
          {slice.cabinClass && (
            <span className="capitalize">{slice.cabinClass.replace("_", " ")}</span>
          )}
          {slice.stops === 0 ? (
            <span>Nonstop</span>
          ) : (
            <span>
              {slice.stops} stop{slice.stops > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {dep && (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" />
            {fmtDate(dep)}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-4">
        <div className="min-w-0">
          <p className="text-lg font-semibold tabular-nums leading-none">
            {slice.origin}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
            {fmtTime(dep)}
          </p>
          {slice.originName && (
            <p className="text-[10px] text-muted-foreground/80 truncate max-w-[14ch]">
              {slice.originName}
            </p>
          )}
        </div>
        <div className="flex-1 h-px bg-border" />
        <div className="text-right min-w-0">
          <p className="text-lg font-semibold tabular-nums leading-none">
            {slice.destination}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
            {fmtTime(arr)}
            {!sameDay && arr ? "*" : ""}
          </p>
          {slice.destinationName && (
            <p className="text-[10px] text-muted-foreground/80 truncate max-w-[14ch] ml-auto">
              {slice.destinationName}
            </p>
          )}
        </div>
      </div>
      {!sameDay && arr && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          *Arrives {fmtDate(arr)}
        </p>
      )}
    </div>
  );
}

function parseISO(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
