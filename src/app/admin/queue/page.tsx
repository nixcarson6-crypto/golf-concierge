/**
 * Concierge-by-hand queue — the launch safety net.
 *
 * Every booking the agent + APIs couldn't auto-complete (FAILED / NEEDS_REVIEW)
 * lands here with EVERYTHING an operator needs to finish it by hand in ~60s:
 * the customer, the venue + a direct booking link, the dates/party, and the
 * full traveler identity (name, DOB, email, phone, address). Mark it booked
 * with a confirmation code and it flips to CONFIRMED for the customer.
 *
 * So nothing ever dead-ends on a customer: agent gets ~85%, this catches the
 * rest. Admin-only.
 */

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { ResolveButton } from "./queue-client";

export const dynamic = "force-dynamic";

function fmtWhen(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const d = (x: Date) =>
    x.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
  return end ? `${d(start)} → ${d(end)}` : d(start);
}

export default async function ConciergeQueuePage() {
  await requireAdmin();

  const bookings = await db.booking.findMany({
    where: { status: { in: ["FAILED", "NEEDS_REVIEW"] } },
    orderBy: { createdAt: "desc" },
    include: {
      itineraryItem: {
        select: {
          title: true,
          location: true,
          address: true,
          startTime: true,
          endTime: true,
          type: true,
          metadata: true,
        },
      },
      trip: {
        select: {
          id: true,
          title: true,
          destination: true,
          groupSize: true,
          owner: {
            select: {
              name: true,
              email: true,
              phone: true,
              legalGivenName: true,
              legalFamilyName: true,
              dateOfBirth: true,
              gender: true,
              addressLine1: true,
              addressCity: true,
              addressState: true,
              addressPostalCode: true,
              addressCountry: true,
            },
          },
        },
      },
    },
  });

  return (
    <div className="min-h-dvh bg-concierge-radial">
      <header className="container py-6 flex items-center justify-between">
        <Link
          href="/dashboard"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition text-sm"
        >
          <ChevronLeft className="size-4" /> Dashboard
        </Link>
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Concierge queue
        </span>
      </header>

      <main className="container pb-24 max-w-3xl">
        <h1 className="text-display text-4xl tracking-tight">To book by hand</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {bookings.length === 0
            ? "Nothing waiting — the agent caught everything. 🎉"
            : `${bookings.length} reservation${bookings.length === 1 ? "" : "s"} the agent couldn't finish. Book each on the venue's site, then mark it done.`}
        </p>

        <div className="mt-8 space-y-5">
          {bookings.map((b) => {
            const o = b.trip.owner;
            const meta = (b.metadata ?? {}) as Record<string, unknown>;
            const fb = (meta.fallbackContact ?? {}) as {
              website?: string | null;
              phone?: string | null;
              email?: string | null;
            };
            const itemMeta = (b.itineraryItem.metadata ?? {}) as {
              partySize?: number;
            };
            const party = itemMeta.partySize ?? b.trip.groupSize ?? 1;
            const venueLink = fb.website ?? b.vendorUrl ?? null;
            const reason = (meta.failureReason as string | null) ?? null;
            const agentMsg = (meta.agentMessage as string | null) ?? null;
            const fullName =
              [o.legalGivenName, o.legalFamilyName].filter(Boolean).join(" ") ||
              o.name ||
              "—";
            const addr = [
              o.addressLine1,
              o.addressCity,
              o.addressState,
              o.addressPostalCode,
              o.addressCountry,
            ]
              .filter(Boolean)
              .join(", ");

            return (
              <section
                key={b.id}
                className="glass rounded-2xl p-5 space-y-4 border border-border/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold tracking-tight">
                      {b.itineraryItem.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {b.itineraryItem.type} ·{" "}
                      {b.itineraryItem.location ??
                        b.trip.destination ??
                        "location n/a"}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-[10px] uppercase tracking-widest rounded-full px-2 py-1 ${
                      b.status === "FAILED"
                        ? "bg-red-500/10 text-red-600"
                        : "bg-amber-500/10 text-amber-600"
                    }`}
                  >
                    {b.status === "FAILED" ? "Failed" : "Review"}
                    {reason ? ` · ${reason}` : ""}
                  </span>
                </div>

                {/* Booking facts */}
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <Fact label="When" value={fmtWhen(b.itineraryItem.startTime, b.itineraryItem.endTime)} />
                  <Fact label="Party" value={`${party} ${party === 1 ? "person" : "people"}`} />
                </div>

                {/* Traveler identity to fill the form */}
                <div className="rounded-xl bg-surface-sunken/50 border border-border/60 p-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <Fact label="Customer" value={o.name ?? "—"} />
                  <Fact label="Legal name" value={fullName} />
                  <Fact label="Email" value={o.email} copyable />
                  <Fact label="Phone" value={o.phone ?? "—"} copyable />
                  <Fact
                    label="DOB"
                    value={o.dateOfBirth ? o.dateOfBirth.toISOString().slice(0, 10) : "—"}
                  />
                  <Fact label="Gender" value={o.gender === "f" ? "Female" : o.gender === "m" ? "Male" : "—"} />
                  <div className="col-span-2">
                    <Fact label="Address" value={addr || "— (not on file)"} copyable={!!addr} />
                  </div>
                </div>

                {agentMsg && (
                  <p className="text-xs text-foreground/70 leading-snug">
                    <span className="text-muted-foreground">Agent got to: </span>
                    {agentMsg}
                  </p>
                )}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {venueLink && (
                    <a
                      href={venueLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-xl bg-foreground text-background text-xs font-semibold px-3 py-2 hover:bg-foreground/90"
                    >
                      Open venue booking site
                    </a>
                  )}
                  {fb.phone && (
                    <a
                      href={`tel:${fb.phone.replace(/[^+\d]/g, "")}`}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 text-xs font-semibold px-3 py-2 hover:bg-surface-raised"
                    >
                      Call {fb.phone}
                    </a>
                  )}
                  <Link
                    href={`/trips/${b.trip.id}`}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border/70 text-xs font-semibold px-3 py-2 hover:bg-surface-raised"
                  >
                    View trip
                  </Link>
                  <div className="ml-auto">
                    <ResolveButton bookingId={b.id} />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function Fact({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className={`truncate ${copyable ? "select-all" : ""}`}>{value}</p>
    </div>
  );
}
