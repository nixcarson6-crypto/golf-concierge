import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Plus, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  const [trips, notifications] = await Promise.all([
    db.trip.findMany({
      where: {
        OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
      },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { members: true } } },
    }),
    db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

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
          <Button asChild variant="navy" size="lg">
            <Link href="/trips/new">
              <Plus className="size-4" /> New trip
            </Link>
          </Button>
        </div>

        {trips.length === 0 ? (
          <EmptyState />
        ) : (
          <DashboardClient
            trips={trips.map((t) => ({
              id: t.id,
              title: t.title,
              destination: t.destination,
              startDate: t.startDate?.toISOString() ?? null,
              endDate: t.endDate?.toISOString() ?? null,
              groupSize: t.groupSize,
              budgetTotal: t.budgetTotal,
              status: t.status,
              memberCount: t._count.members,
            }))}
            notifications={notifications.map((n) => ({
              id: n.id,
              tripId: n.tripId,
              type: n.type,
              title: n.title,
              message: n.message,
              readAt: n.readAt?.toISOString() ?? null,
              createdAt: n.createdAt.toISOString(),
            }))}
          />
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-12 glass rounded-3xl p-12 text-center max-w-xl mx-auto">
      <div className="mx-auto size-12 grid place-items-center rounded-2xl border border-[hsl(var(--navy)/0.3)] bg-[hsl(var(--navy)/0.08)] text-[hsl(var(--navy))]">
        <Sparkles className="size-5" />
      </div>
      <h2 className="mt-6 text-display text-2xl tracking-tight">
        Let's plan something memorable.
      </h2>
      <p className="mt-3 text-muted-foreground">
        Describe the trip you want — group, dates, budget, vibe — and your
        concierge takes it from there.
      </p>
      <Button asChild variant="navy" size="lg" className="mt-8">
        <Link href="/trips/new">Start your first trip</Link>
      </Button>
    </div>
  );
}
