"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bell, Search, Copy, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [cloningId, setCloningId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  // Multi-select state. Empty set = normal browse mode; non-empty
  // surfaces the bulk-action toolbar above the grid.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const toggleSelect = React.useCallback((tripId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  }, []);

  const filtered = React.useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return trips;
    return trips.filter(
      (trip) =>
        trip.title.toLowerCase().includes(t) ||
        (trip.destination ?? "").toLowerCase().includes(t),
    );
  }, [q, trips]);

  const active = filtered.filter(
    (t) => t.status !== "COMPLETED" && t.status !== "CANCELLED",
  );
  const past = filtered.filter(
    (t) => t.status === "COMPLETED" || t.status === "CANCELLED",
  );

  const unread = notifications.filter((n) => !n.readAt);

  const cloneTrip = async (tripId: string) => {
    setCloningId(tripId);
    try {
      const res = await fetch(`/api/trips/${tripId}/clone`, { method: "POST" });
      if (!res.ok) {
        toast.error("Couldn't clone that trip.");
        return;
      }
      const { tripId: newId } = await res.json();
      toast.success("Cloned. Tell the concierge what to change.");
      router.push(`/trips/${newId}`);
    } finally {
      setCloningId(null);
    }
  };

  const deleteTrip = async (tripId: string, title: string) => {
    if (!confirm(`Delete "${title}"? This can't be undone.`)) return;
    setDeletingId(tripId);
    try {
      const res = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Couldn't delete that trip.");
        return;
      }
      toast.success("Trip deleted.");
      router.refresh();
    } finally {
      setDeletingId(null);
    }
  };

  const selectAllVisible = () => {
    setSelected(new Set(filtered.map((t) => t.id)));
  };
  const clearSelection = () => setSelected(new Set());

  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length} ${ids.length === 1 ? "trip" : "trips"}? This can't be undone.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/trips/${id}`, { method: "DELETE" }).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const ok = ids.length - failed;
      if (ok > 0) toast.success(`Deleted ${ok} ${ok === 1 ? "trip" : "trips"}.`);
      if (failed > 0) toast.error(`${failed} couldn't be deleted.`);
      setSelected(new Set());
      router.refresh();
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
      <section className="lg:col-span-8 xl:col-span-9 space-y-4">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by destination or trip name…"
              className="pl-9"
            />
          </div>
          {filtered.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={
                selected.size === filtered.length
                  ? clearSelection
                  : selectAllVisible
              }
              className="shrink-0"
            >
              {selected.size === filtered.length ? "Clear" : "Select all"}
            </Button>
          )}
        </div>
        {/* Bulk-action toolbar — slides in when at least one trip is
            selected. Stays sticky-feeling without literal sticky so it
            doesn't fight the search bar layout above. */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-[hsl(var(--navy))]/30 bg-[hsl(var(--navy))]/5 px-4 py-2.5">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">
                {selected.size}
              </span>{" "}
              {selected.size === 1 ? "trip" : "trips"} selected
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                disabled={bulkDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={bulkDelete}
                disabled={bulkDeleting}
                className="text-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))]/10 border-[hsl(var(--destructive))]/30"
              >
                <Trash2 className="size-3.5 mr-1.5" />
                {bulkDeleting
                  ? "Deleting…"
                  : `Delete ${selected.size > 1 ? `${selected.size} trips` : "trip"}`}
              </Button>
            </div>
          </div>
        )}
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground p-8 text-center">
            No trips match "{q}".
          </p>
        ) : (
          <>
            <TripGrid
              trips={active}
              cloningId={cloningId}
              deletingId={deletingId}
              selected={selected}
              onClone={cloneTrip}
              onDelete={deleteTrip}
              onToggleSelect={toggleSelect}
            />
            {past.length > 0 && (
              <div className="pt-8">
                <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-3">
                  Past trips
                </h3>
                <TripGrid
                  trips={past}
                  cloningId={cloningId}
                  deletingId={deletingId}
                  selected={selected}
                  onClone={cloneTrip}
                  onDelete={deleteTrip}
                  onToggleSelect={toggleSelect}
                  muted
                />
              </div>
            )}
          </>
        )}
      </section>

      <aside className="lg:col-span-4 xl:col-span-3">
        <div className="glass rounded-2xl p-5 sticky top-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Bell className="size-4 text-[hsl(var(--navy))]" />
              Activity
              {unread.length > 0 && (
                <span className="text-[10px] rounded-full bg-[hsl(var(--navy)/0.15)] border border-[hsl(var(--navy)/0.3)] text-[hsl(var(--navy))] px-1.5 py-0.5">
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
                        : "border-[hsl(var(--navy)/0.3)] bg-[hsl(var(--navy)/0.05)] hover:bg-[hsl(var(--navy)/0.08)]",
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

function TripGrid({
  trips,
  cloningId,
  deletingId,
  selected,
  onClone,
  onDelete,
  onToggleSelect,
  muted,
}: {
  trips: Trip[];
  cloningId: string | null;
  deletingId: string | null;
  selected: Set<string>;
  onClone: (id: string) => void;
  onDelete: (id: string, title: string) => void;
  onToggleSelect: (id: string) => void;
  muted?: boolean;
}) {
  if (trips.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing here yet.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {trips.map((trip) => {
        const isSelected = selected.has(trip.id);
        return (
        <div
          key={trip.id}
          className={cn(
            "group glass rounded-2xl p-6 transition relative",
            muted ? "opacity-80 hover:opacity-100" : "hover:border-foreground/20",
            isSelected && "ring-2 ring-[hsl(var(--navy))] ring-offset-2 ring-offset-background",
          )}
        >
          {/* Selection checkbox — top-left so it doesn't fight the
              status badge on the right. Always visible (vs. hover) so
              "select all" produces an obvious filled state on every
              card without the user having to wave the mouse around. */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSelect(trip.id);
            }}
            aria-label={isSelected ? "Deselect this trip" : "Select this trip"}
            className={cn(
              "absolute top-3 left-3 size-5 rounded-md border grid place-items-center transition z-10",
              isSelected
                ? "bg-[hsl(var(--navy))] border-[hsl(var(--navy))] text-white"
                : "bg-background/70 border-border hover:border-foreground/40 opacity-0 group-hover:opacity-100 focus:opacity-100",
            )}
          >
            {isSelected && <Check className="size-3.5" strokeWidth={3} />}
          </button>
          <Link href={`/trips/${trip.id}`} className="block">
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
              <ArrowRight className="size-4 text-muted-foreground transition group-hover:opacity-0" />
            </div>
          </Link>
          <div className="absolute bottom-5 right-5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClone(trip.id);
              }}
              disabled={cloningId === trip.id}
              className="size-7 rounded-lg grid place-items-center text-muted-foreground hover:text-foreground hover:bg-surface-raised transition disabled:opacity-50"
              aria-label="Clone this trip"
              title="Clone this trip"
            >
              <Copy className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(trip.id, trip.title);
              }}
              disabled={deletingId === trip.id}
              className="size-7 rounded-lg grid place-items-center text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition disabled:opacity-50"
              aria-label="Delete this trip"
              title="Delete this trip"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}
