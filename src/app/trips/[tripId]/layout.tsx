import { notFound } from "next/navigation";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { ChevronLeft } from "lucide-react";
import { requireTripAccess } from "@/lib/auth";

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
      <header className="border-b border-border/60 bg-surface/50 backdrop-blur-xl sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/dashboard"
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition text-sm"
            >
              <ChevronLeft className="size-4" /> Trips
            </Link>
            <span className="text-muted-foreground/40">·</span>
            <h1 className="text-display text-base truncate">{trip.title}</h1>
          </div>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>

      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}
