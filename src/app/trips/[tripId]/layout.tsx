import { notFound } from "next/navigation";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { ChevronLeft } from "lucide-react";
import { requireTripAccess } from "@/lib/auth";
import { TripNav } from "@/components/concierge/trip-nav";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import { tripStatusLabel } from "@/lib/trip-status";

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

  return (
    <div className="relative min-h-dvh bg-concierge-radial flex flex-col">
      <header className="border-b border-border/60 bg-surface/40 backdrop-blur-xl sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/dashboard"
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition text-sm"
            >
              <ChevronLeft className="size-4" /> Dashboard
            </Link>
            <span className="text-muted-foreground/40">·</span>
            <div className="min-w-0">
              <h1 className="text-display text-base truncate">{trip.title}</h1>
              <p className="text-xs text-muted-foreground truncate">
                {trip.destination ?? "Destination TBD"} ·{" "}
                {formatDateRange(trip.startDate, trip.endDate)} ·{" "}
                {trip.groupSize ? `${trip.groupSize} players` : "Group TBD"}
                {trip.budgetTotal
                  ? ` · ${formatCurrency(trip.budgetTotal / 100)}`
                  : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="muted" size="sm">
              {tripStatusLabel(trip.status)}
            </Badge>
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
        <div className="container pb-3">
          <TripNav tripId={trip.id} />
        </div>
      </header>

      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}
