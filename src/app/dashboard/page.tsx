import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { ArrowRight, Plus, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import { tripStatusLabel } from "@/lib/trip-status";

export default async function DashboardPage() {
  const user = await requireUser();
  const trips = await db.trip.findMany({
    where: {
      OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
    },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { members: true } },
    },
  });

  return (
    <div className="relative min-h-dvh bg-concierge-radial">
      <header className="container py-6 flex items-center justify-between">
        <Link href="/" className="text-display text-xl">
          Golf Concierge
        </Link>
        <UserButton afterSignOutUrl="/" />
      </header>

      <main className="container pb-24">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
              Welcome back, {user.name?.split(" ")[0] ?? "friend"}
            </p>
            <h1 className="text-display text-4xl tracking-tight">Your trips</h1>
          </div>
          <Button asChild variant="gold" size="lg">
            <Link href="/trips/new">
              <Plus className="size-4" /> New trip
            </Link>
          </Button>
        </div>

        {trips.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {trips.map((trip) => (
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
                  {formatDateRange(trip.startDate, trip.endDate)} ·{" "}
                  {trip.groupSize ? `${trip.groupSize} players` : "Group TBD"}
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
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 glass rounded-3xl p-12 text-center max-w-xl mx-auto">
      <div className="mx-auto size-12 grid place-items-center rounded-2xl border border-[hsl(var(--gold)/0.3)] bg-[hsl(var(--gold)/0.08)] text-[hsl(var(--gold))]">
        <Sparkles className="size-5" />
      </div>
      <h2 className="mt-6 text-display text-2xl tracking-tight">
        Let's plan something memorable.
      </h2>
      <p className="mt-3 text-muted-foreground">
        Describe the trip you want — group, dates, budget, vibe — and your
        concierge takes it from there.
      </p>
      <Button asChild variant="gold" size="lg" className="mt-8">
        <Link href="/trips/new">
          Start your first trip <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
