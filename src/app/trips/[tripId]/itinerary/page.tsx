import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { ItineraryView } from "./itinerary-view";

export const dynamic = "force-dynamic";

export default async function ItineraryPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    notFound();
  }
  if (!access.trip) notFound();

  const itinerary = await db.itinerary.findFirst({
    where: { tripId, status: { in: ["CURRENT", "APPROVED"] } },
    orderBy: { version: "desc" },
    include: {
      items: {
        orderBy: { orderIndex: "asc" },
        include: { booking: true },
      },
    },
  });

  if (!itinerary) {
    return (
      <div className="container py-16 text-center max-w-xl mx-auto">
        <Sparkles className="mx-auto size-5 text-[hsl(var(--navy))]" />
        <h1 className="mt-4 text-display text-2xl tracking-tight">
          Your itinerary is forming.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Once we have your destination, the concierge will draft a day-by-day plan.
        </p>
      </div>
    );
  }

  const changes = ((itinerary.diff as { changes?: string[] } | null)?.changes) ?? [];

  return (
    <div className="container py-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Itinerary · v{itinerary.version}
          </p>
          <h1 className="mt-1 text-display text-3xl tracking-tight">
            Day by day.
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {itinerary.totalCost && (
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Total
              </p>
              <p className="text-display text-xl num-tabular">
                {formatCurrency(itinerary.totalCost / 100)}
              </p>
            </div>
          )}
          {itinerary.status === "APPROVED" && (
            <Badge variant="emerald">Approved · booking</Badge>
          )}
        </div>
      </div>

      {itinerary.aiSummary && (
        <div className="mt-6 glass rounded-2xl p-5 flex gap-3 items-start max-w-3xl">
          <Sparkles className="size-4 mt-0.5 text-[hsl(var(--navy))] shrink-0" />
          <p className="text-sm leading-relaxed">{itinerary.aiSummary}</p>
        </div>
      )}

      {changes.length > 0 && (
        <div className="mt-4 glass rounded-2xl p-5 max-w-3xl">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            What changed
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            {changes.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[hsl(var(--navy))]">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ItineraryView
        tripId={tripId}
        itineraryId={itinerary.id}
        readOnly={itinerary.status !== "CURRENT"}
        items={itinerary.items.map((i) => ({
          id: i.id,
          type: i.type,
          title: i.title,
          description: i.description,
          location: i.location,
          startTime: i.startTime?.toISOString() ?? null,
          endTime: i.endTime?.toISOString() ?? null,
          cost: i.cost,
          status: i.status,
          confirmationState: i.confirmationState,
          aiRationale: i.aiRationale,
          locked: Boolean((i.metadata as { locked?: boolean } | null)?.locked),
        }))}
      />
    </div>
  );
}
