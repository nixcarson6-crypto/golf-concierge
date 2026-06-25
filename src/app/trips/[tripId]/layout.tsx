import { notFound } from "next/navigation";
import Link from "next/link";
import { LayoutGrid, Plus } from "lucide-react";
import { AccountButton } from "@/components/account-button";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { cn } from "@/lib/utils";
import { tripDisplayLabel } from "@/lib/trip-display";

export default async function TripLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    notFound();
  }
  const trip = access.trip;
  if (!trip) notFound();

  const user = await requireUser();
  const trips = await db.trip.findMany({
    where: {
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      destination: true,
      legs: { select: { destination: true }, orderBy: { legIndex: "asc" } },
    },
    take: 12,
  });
  // Pull the active trip's legs so the main header label matches the tabs.
  const activeLegs = await db.tripLeg.findMany({
    where: { tripId: trip.id },
    orderBy: { legIndex: "asc" },
    select: { destination: true },
  });
  const activeLabel = tripDisplayLabel({
    title: trip.title,
    destination: trip.destination,
    legs: activeLegs,
  });

  return (
    <div className="relative min-h-dvh bg-concierge-radial flex flex-col">
      <header className="border-b border-border/60 bg-surface/50 backdrop-blur-xl sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Link
              href="/trips"
              className="inline-flex items-center gap-2 shrink-0 text-muted-foreground hover:text-foreground transition text-sm rounded-lg px-2.5 py-1.5 hover:bg-surface-raised whitespace-nowrap"
            >
              <LayoutGrid className="size-4" />
              <span>My trips</span>
            </Link>
            <span className="text-border shrink-0" aria-hidden>
              /
            </span>
            <h1 className="text-display text-base sm:text-lg tracking-tight truncate min-w-0">
              {activeLabel}
            </h1>
          </div>
          <div className="shrink-0">
            <AccountButton name={user.name} email={user.email} />
          </div>
        </div>
        <TripTabs trips={trips} activeId={tripId} />
      </header>

      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}


function TripTabs({
  trips,
  activeId,
}: {
  trips: {
    id: string;
    title: string;
    destination: string | null;
    legs: { destination: string }[];
  }[];
  activeId: string;
}) {
  return (
    <div className="border-t border-border/40">
      <div className="container py-2 flex items-center gap-1 overflow-x-auto no-scrollbar">
        {trips.map((t) => {
          const active = t.id === activeId;
          const label = tripDisplayLabel(t);
          return (
            <Link
              key={t.id}
              href={`/trips/${t.id}`}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-lg text-sm transition whitespace-nowrap max-w-[220px] truncate",
                active
                  ? "bg-surface-raised text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-raised/60",
              )}
              title={label}
            >
              {label}
            </Link>
          );
        })}
        <Link
          href="/trips/new"
          className="shrink-0 ml-1 grid place-items-center size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface-raised transition"
          aria-label="New trip"
          title="New trip"
        >
          <Plus className="size-4" />
        </Link>
      </div>
    </div>
  );
}
