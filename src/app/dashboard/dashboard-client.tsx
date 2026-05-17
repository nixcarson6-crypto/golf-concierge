"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Bell, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDateRange, relativeTime } from "@/lib/utils";
import { tripStatusLabel } from "@/lib/trip-status";
import type { TripStatus, NotificationType } from "@prisma/client";
import { cn } from "@/lib/utils";

type Trip = {
  id: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  groupSize: number | null;
  budgetTotal: number | null;
  status: TripStatus;
  memberCount: number;
};

type Notification = {
  id: string;
  tripId: string | null;
  type: NotificationType;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

export function DashboardClient({
  trips,
  notifications,
}: {
  trips: Trip[];
  notifications: Notification[];
}) {
  const [q, setQ] = React.useState("");
  const filtered = React.useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return trips;
    return trips.filter(
      (trip) =>
        trip.title.toLowerCase().includes(t) ||
        (trip.destination ?? "").toLowerCase().includes(t),
    );
  }, [q, trips]);

  const unread = notifications.filter((n) => !n.readAt);

  return (
    <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
      <section className="lg:col-span-8 xl:col-span-9 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by destination or trip name…"
            className="pl-9"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground p-8 text-center">
            No trips match "{q}".
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((trip) => (
              <Link
                key={trip.id}
                href={`/trips/${trip.id}`}
                className="group glass rounded-2xl p-6 hover:border-foreground/20 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {trip.destination ?? "Destination TBD"}
                    </p>
                    <h3 className="mt-1 text-display text-xl tracking-tight truncate">
                      {trip.title}
                    </h3>
                  </div>
                  <Badge variant="muted" size="sm">
                    {tripStatusLabel(trip.status)}
                  </Badge>
                </div>
                <p className="mt-4 text-sm text-muted-foreground">
                  {formatDateRange(
                    trip.startDate ? new Date(trip.startDate) : null,
                    trip.endDate ? new Date(trip.endDate) : null,
                  )}{" "}
                  ·{" "}
                  {trip.groupSize
                    ? `${trip.groupSize} players`
                    : `${trip.memberCount} ${trip.memberCount === 1 ? "member" : "members"}`}
                </p>
                <div className="mt-6 flex items-center justify-between">
                  <p className="num-tabular text-sm">
                    {trip.budgetTotal
                      ? formatCurrency(trip.budgetTotal / 100)
                      : "—"}
                  </p>
                  <ArrowRight className="size-4 text-muted-foreground group-hover:translate-x-0.5 group-hover:text-foreground transition" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <aside className="lg:col-span-4 xl:col-span-3">
        <div className="glass rounded-2xl p-5 sticky top-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Bell className="size-4 text-[hsl(var(--gold))]" />
              Activity
              {unread.length > 0 && (
                <span className="text-[10px] rounded-full bg-[hsl(var(--gold)/0.15)] border border-[hsl(var(--gold)/0.3)] text-[hsl(var(--gold))] px-1.5 py-0.5">
                  {unread.length}
                </span>
              )}
            </h2>
          </div>
          {notifications.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              You're all caught up.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {notifications.map((n) => (
                <li key={n.id}>
                  <Link
                    href={n.tripId ? `/trips/${n.tripId}` : "/dashboard"}
                    className={cn(
                      "block rounded-xl border px-3 py-2.5 transition",
                      n.readAt
                        ? "border-border/40 bg-surface-raised/20 hover:bg-surface-raised/40"
                        : "border-[hsl(var(--gold)/0.3)] bg-[hsl(var(--gold)/0.05)] hover:bg-[hsl(var(--gold)/0.08)]",
                    )}
                  >
                    <p className="text-xs font-medium leading-tight">{n.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                      {n.message}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-1">
                      {relativeTime(n.createdAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
