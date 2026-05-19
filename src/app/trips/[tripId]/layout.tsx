import { notFound } from "next/navigation";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { LayoutGrid, Plus } from "lucide-react";
import { requireTripAccess, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { cn } from "@/lib/utils";

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
    select: { id: true, title: true },
    take: 12,
  });

  return (
    <div className="relative min-h-dvh bg-concierge-radial flex flex-col">
      <header className="border-b border-border/60 bg-surface/50 backdrop-blur-xl sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/trips"
              className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition text-sm rounded-lg px-2 py-1 hover:bg-surface-raised"
            >
              <LayoutGrid className="size-4" /> My trips
            </Link>
            <span className="text-muted-foreground/40">·</span>
            <h1 className="text-display text-base truncate">{trip.title}</h1>
          </div>
          <UserButton afterSignOutUrl="/" />
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
  trips: { id: string; title: string }[];
  activeId: string;
}) {
  return (
    <div className="border-t border-border/40">
      <div className="container py-2 flex items-center gap-1 overflow-x-auto no-scrollbar">
        {trips.map((t) => {
          const active = t.id === activeId;
          return (
            <Link
              key={t.id}
              href={`/trips/${t.id}`}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-lg text-sm transition whitespace-nowrap max-w-[180px] truncate",
                active
                  ? "bg-surface-raised text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-raised/60",
              )}
              title={t.title}
            >
              {t.title}
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
