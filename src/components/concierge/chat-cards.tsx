"use client";

import * as React from "react";
import {
  Plane,
  BedDouble,
  Flag,
  Clock,
  MapPin,
  Star,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  ExternalLink,
  Copy,
  ShieldCheck,
  Car,
  Utensils,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import type {
  ChatCard,
  FlightCard as FlightCardData,
  HotelCard as HotelCardData,
  TeeTimeCard as TeeTimeCardData,
  BookingConfirmationCard as BookingConfirmationCardData,
} from "@/lib/ai/chat-cards";

const fmtTime = (iso: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

const fmtDate = (iso: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const fmtDuration = (mins: number) => {
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h}h` : null, m ? `${m}m` : null].filter(Boolean).join(" ");
};

const fmtMoney = (cents: number, currency: string) => {
  if (currency === "USD" || !currency) return formatCurrency(cents / 100);
  return `${currency} ${(cents / 100).toFixed(0)}`;
};

export function ChatCardsList({ cards }: { cards: ChatCard[] }) {
  if (!cards || cards.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {cards.map((card, i) => {
        if (card.kind === "flight")
          return <FlightCard key={`f-${card.offerId}-${i}`} card={card} />;
        if (card.kind === "hotel")
          return <HotelCard key={`h-${card.rateKey}-${i}`} card={card} />;
        if (card.kind === "tee_time")
          return <TeeTimeCard key={`t-${card.courseName}-${i}`} card={card} />;
        if (card.kind === "booking_confirmation")
          return (
            <BookingConfirmationCard
              key={`bc-${card.bookingReference}-${i}`}
              card={card}
            />
          );
        return null;
      })}
    </div>
  );
}

function BookingConfirmationCard({
  card,
}: {
  card: BookingConfirmationCardData;
}) {
  const [copied, setCopied] = React.useState(false);
  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(card.bookingReference);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard might be blocked; silent fail is fine
    }
  };

  const Icon = card.bookingType === "flight"
    ? Plane
    : card.bookingType === "hotel"
      ? BedDouble
      : card.bookingType === "tee_time"
        ? Flag
        : card.bookingType === "car"
          ? Car
          : Utensils;

  const accentBg = card.isStub
    ? "bg-[hsl(var(--copper))]/10 border-[hsl(var(--copper))]/40"
    : "bg-[hsl(var(--emerald))]/8 border-[hsl(var(--emerald))]/35";

  const StatusIcon = card.isStub ? Sparkles : ShieldCheck;
  const statusColor = card.isStub
    ? "text-[hsl(var(--copper))]"
    : "text-[hsl(var(--emerald))]";

  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3.5 space-y-3",
        accentBg,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="size-9 rounded-lg bg-surface-raised grid place-items-center text-foreground shrink-0">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80 leading-none mb-0.5 flex items-center gap-1">
              <StatusIcon className={cn("size-3", statusColor)} />
              {card.isStub ? "Pencilled in" : "Confirmed"}
              {" · "}
              <span className="capitalize">{card.bookingType.replace("_", " ")}</span>
            </p>
            <p className="text-sm font-semibold leading-tight truncate">
              {card.vendor}
            </p>
          </div>
        </div>
        {card.totalAmount > 0 && (
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold tabular-nums">
              {card.currency === "USD" || !card.currency
                ? formatCurrency(card.totalAmount / 100)
                : `${card.currency} ${(card.totalAmount / 100).toFixed(0)}`}
            </p>
            <p className="text-[10px] text-muted-foreground">total</p>
          </div>
        )}
      </div>

      <p className="text-xs text-foreground/80">{card.summary}</p>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none mb-1">
            Confirmation
          </p>
          <button
            type="button"
            onClick={copyRef}
            className="inline-flex items-center gap-1.5 text-sm font-mono font-semibold tabular-nums text-foreground hover:text-[hsl(var(--copper))] transition"
            title="Copy confirmation number"
          >
            {card.bookingReference}
            <Copy className="size-3 opacity-60" />
            {copied && (
              <span className="text-[10px] text-[hsl(var(--emerald))] font-sans font-normal">
                Copied
              </span>
            )}
          </button>
        </div>
        {card.verifyUrl && card.verifyLabel && (
          <a
            href={card.verifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border border-border bg-surface-raised hover:bg-surface-raised/80 hover:border-foreground/30 transition"
          >
            {card.verifyLabel}
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {card.partyNames && card.partyNames.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {card.partyNames.map((n, i) => (
            <span
              key={i}
              className="text-[10px] px-2 py-0.5 rounded-full bg-surface-raised/70 text-muted-foreground"
            >
              {n}
            </span>
          ))}
        </div>
      )}

      {card.contactEmail && !card.isStub && (
        <p className="text-[10px] text-muted-foreground">
          Confirmation will be emailed to {card.contactEmail}
        </p>
      )}
      {card.isStub && (
        <p className="text-[10px] text-[hsl(var(--copper))]/90">
          Pencilled in — we&apos;ll lock this with the partner once API access lands.
        </p>
      )}
    </div>
  );
}

function FlightCard({ card }: { card: FlightCardData }) {
  const dateLabel = fmtDate(card.departISO);
  const sameDayArrival = fmtDate(card.arriveISO) === dateLabel;
  return (
    <div className="rounded-2xl border border-border/70 bg-surface-raised/70 px-4 py-3 hover:border-foreground/20 transition">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-[hsl(var(--navy))]/15 grid place-items-center text-[hsl(var(--navy))] shrink-0">
          <Plane className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight truncate">
                {card.airline}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {card.origin} → {card.destination}
                {dateLabel ? ` · ${dateLabel}` : ""}
                {card.stops === 0
                  ? " · Nonstop"
                  : ` · ${card.stops} stop${card.stops > 1 ? "s" : ""}`}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold tabular-nums">
                {fmtMoney(card.totalAmount, card.currency)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                total {card.paxCount > 1 ? `· ${card.paxCount} pax` : ""}
              </p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-foreground/80 tabular-nums">
            <span className="font-medium">{fmtTime(card.departISO)}</span>
            <span className="flex-1 h-px bg-border/80 relative">
              <span className="absolute inset-y-0 -translate-y-1/2 top-1/2 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground bg-surface-raised px-1.5">
                {fmtDuration(card.durationMinutes)}
              </span>
            </span>
            <span className="font-medium">
              {fmtTime(card.arriveISO)}
              {!sameDayArrival ? "*" : ""}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HotelCard({ card }: { card: HotelCardData }) {
  const stars = card.category ? Math.min(5, Math.max(1, card.category)) : null;
  return (
    <div className="rounded-2xl border border-border/70 bg-surface-raised/70 px-4 py-3 hover:border-foreground/20 transition">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-[hsl(var(--copper))]/20 grid place-items-center text-[hsl(var(--copper))] shrink-0">
          <BedDouble className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight truncate">
                {card.hotelName}
              </p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                {stars && (
                  <span className="inline-flex items-center gap-0.5">
                    {Array.from({ length: stars }).map((_, i) => (
                      <Star
                        key={i}
                        className="size-2.5 fill-[hsl(var(--copper))] text-[hsl(var(--copper))]"
                      />
                    ))}
                  </span>
                )}
                {card.city && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-2.5" />
                    {card.city}
                  </span>
                )}
                {card.board && <span>· {card.board}</span>}
                {card.refundable && (
                  <span className="text-[hsl(var(--emerald))]">· Refundable</span>
                )}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold tabular-nums">
                {fmtMoney(card.perNight, card.currency)}
                <span className="text-[10px] text-muted-foreground font-normal">
                  {" "}/ night
                </span>
              </p>
              <p className="text-[10px] text-muted-foreground tabular-nums">
                {fmtMoney(card.total, card.currency)} · {card.nights} night
                {card.nights > 1 ? "s" : ""}
              </p>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {fmtDate(card.checkIn)} → {fmtDate(card.checkOut)}
          </p>
        </div>
      </div>
    </div>
  );
}

function TeeTimeCard({ card }: { card: TeeTimeCardData }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-surface-raised/70 px-4 py-3 hover:border-foreground/20 transition">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-[hsl(var(--emerald))]/15 grid place-items-center text-[hsl(var(--emerald))] shrink-0">
          <Flag className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium leading-tight truncate">
                {card.courseName}
              </p>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                <Clock className="size-2.5" />
                {fmtDate(card.teeOffISO)} · {fmtTime(card.teeOffISO)}
                <span>· {card.players} players</span>
                {card.isStub && (
                  <span className="text-[hsl(var(--copper))]">· Pencilled in</span>
                )}
              </p>
            </div>
            {typeof card.greenFeePerPlayer === "number" && (
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold tabular-nums">
                  {fmtMoney(card.greenFeePerPlayer, card.currency ?? "USD")}
                </p>
                <p className="text-[10px] text-muted-foreground">/ player</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export type ToolIndicator = {
  id: string;
  tool: string;
  label: string;
  status: "running" | "done" | "failed";
};

export function ToolIndicatorList({ tools }: { tools: ToolIndicator[] }) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="mt-2 space-y-1">
      {tools.map((t) => (
        <div
          key={t.id}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border transition",
            t.status === "running" &&
              "border-[hsl(var(--copper))]/40 bg-[hsl(var(--copper))]/10 text-[hsl(var(--copper))]",
            t.status === "done" &&
              "border-[hsl(var(--emerald))]/30 bg-[hsl(var(--emerald))]/10 text-[hsl(var(--emerald))]",
            t.status === "failed" &&
              "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {t.status === "running" && <Loader2 className="size-3 animate-spin" />}
          {t.status === "done" && <CheckCircle2 className="size-3" />}
          {t.status === "failed" && <XCircle className="size-3" />}
          <span>{t.label}</span>
        </div>
      ))}
    </div>
  );
}

export function StreamingTypingDots() {
  return (
    <div className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Sparkles className="size-3 opacity-60" />
      <span className="flex items-center gap-1">
        <span className="size-1 rounded-full bg-current animate-pulse-soft" />
        <span className="size-1 rounded-full bg-current animate-pulse-soft [animation-delay:120ms]" />
        <span className="size-1 rounded-full bg-current animate-pulse-soft [animation-delay:240ms]" />
      </span>
    </div>
  );
}
