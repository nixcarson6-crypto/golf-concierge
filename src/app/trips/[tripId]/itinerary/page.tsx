import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { ApproveItineraryButton } from "./approve-button";

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
        <Sparkles className="mx-auto size-5 text-[hsl(var(--gold))]" />
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
          {itinerary.status === "CURRENT" && (
            <ApproveItineraryButton tripId={tripId} itineraryId={itinerary.id} />
          )}
          {itinerary.status === "APPROVED" && (
            <Badge variant="emerald">Approved · booking in progress</Badge>
          )}
        </div>
      </div>

      {itinerary.aiSummary && (
        <div className="mt-6 glass rounded-2xl p-5 flex gap-3 items-start max-w-3xl">
          <Sparkles className="size-4 mt-0.5 text-[hsl(var(--gold))] shrink-0" />
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
                <span className="text-[hsl(var(--gold))]">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {itinerary.items.map((item) => (
          <ItineraryItemCard
            key={item.id}
            item={{
              id: item.id,
              type: item.type,
              title: item.title,
              description: item.description,
              location: item.location,
              startTime: item.startTime?.toISOString() ?? null,
              endTime: item.endTime?.toISOString() ?? null,
              cost: item.cost,
              status: item.status,
              confirmationState: item.confirmationState,
              aiRationale: item.aiRationale,
            }}
          />
        ))}
      </div>
    </div>
  );
}
