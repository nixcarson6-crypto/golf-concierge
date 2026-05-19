import { notFound } from "next/navigation";
import { Sparkles, Check, ScrollText } from "lucide-react";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateRange } from "@/lib/utils";
import { GenerateSummaryButton } from "./generate-button";

export const dynamic = "force-dynamic";

export default async function SummaryPage({
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
  const trip = access.trip;
  if (!trip) notFound();

  const summary = await db.tripSummary.findUnique({ where: { tripId } });
  const itinerary = await db.itinerary.findFirst({
    where: { tripId, status: "APPROVED" },
    include: { items: { orderBy: { orderIndex: "asc" } } },
    orderBy: { version: "desc" },
  });

  if (!itinerary) {
    return (
      <div className="container py-16 text-center max-w-xl mx-auto">
        <ScrollText className="mx-auto size-5 text-[hsl(var(--navy))]" />
        <h1 className="mt-4 text-display text-2xl tracking-tight">
          Summary unlocks after approval.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Approve the itinerary to generate a polished, shareable trip summary.
        </p>
      </div>
    );
  }

  const highlights =
    ((summary?.highlights as { items?: string[]; substitutions?: string[] } | null)
      ?.items) ?? [];
  const substitutions =
    ((summary?.highlights as { items?: string[]; substitutions?: string[] } | null)
      ?.substitutions) ?? [];

  return (
    <div className="container py-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Trip summary
          </p>
          <h1 className="mt-1 text-display text-3xl tracking-tight">
            {trip.destination ?? trip.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateRange(trip.startDate, trip.endDate)} ·{" "}
            {trip.groupSize ? `${trip.groupSize} players` : "Group"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {summary && (
            <Badge variant="emerald">
              <Check className="size-3" /> Generated
            </Badge>
          )}
          <GenerateSummaryButton tripId={tripId} hasSummary={Boolean(summary)} />
        </div>
      </div>

      {summary && (
        <article className="mt-8 glass rounded-3xl p-7 max-w-3xl">
          <div className="flex items-start gap-3">
            <Sparkles className="size-4 text-[hsl(var(--navy))] mt-1 shrink-0" />
            <p className="text-base leading-relaxed whitespace-pre-wrap">
              {summary.content}
            </p>
          </div>
          {highlights.length > 0 && (
            <>
              <h3 className="mt-7 text-[10px] uppercase tracking-widest text-muted-foreground">
                Highlights
              </h3>
              <ul className="mt-2 space-y-1.5 text-sm">
                {highlights.map((h, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-[hsl(var(--navy))]">·</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {substitutions.length > 0 && (
            <>
              <h3 className="mt-7 text-[10px] uppercase tracking-widest text-muted-foreground">
                Substitutions
              </h3>
              <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                {substitutions.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span>·</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {summary.totalCost != null && (
            <div className="mt-7 pt-5 border-t border-border/60 flex items-center justify-between">
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Trip total
              </p>
              <p className="num-tabular text-display text-2xl">
                {formatCurrency(summary.totalCost / 100)}
                {summary.perPersonCost != null && (
                  <span className="text-muted-foreground text-sm font-normal ml-2">
                    ({formatCurrency(summary.perPersonCost / 100)} pp)
                  </span>
                )}
              </p>
            </div>
          )}
        </article>
      )}

      <div className="mt-10">
        <h2 className="text-display text-xl tracking-tight">Confirmed itinerary</h2>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
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
    </div>
  );
}
