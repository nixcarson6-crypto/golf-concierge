import { notFound } from "next/navigation";
import { Sparkles, Check } from "lucide-react";
import { db } from "@/lib/db";
import { ItineraryItemCard } from "@/components/itinerary/itinerary-item-card";
import { formatCurrency, formatDateRange } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Public, read-only summary page. No auth — knowledge of the share token
 * grants access. Designed to print well: open in browser, Print, "Save as PDF"
 * and you get a polished trip dossier with no UI chrome.
 */
export default async function SharedSummaryPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;
  const summary = await db.tripSummary.findUnique({
    where: { shareToken },
    include: {
      trip: true,
      itinerary: {
        include: {
          items: {
            orderBy: { orderIndex: "asc" },
            include: { booking: true },
          },
        },
      },
    },
  });
  if (!summary) notFound();

  const trip = summary.trip;
  const highlights =
    ((summary.highlights as { items?: string[] } | null)?.items) ?? [];
  const substitutions =
    ((summary.highlights as { substitutions?: string[] } | null)?.substitutions) ?? [];

  return (
    <div className="min-h-dvh bg-background print:bg-white print:text-black">
      <div className="max-w-3xl mx-auto px-6 py-10 print:py-8">
        <header className="flex items-center gap-2 text-sm text-muted-foreground print:text-neutral-600">
          <Sparkles className="size-3.5 text-[hsl(var(--gold))] print:text-amber-700" />
          <span>Golf Concierge · Trip dossier</span>
        </header>

        <h1 className="mt-4 text-display text-5xl tracking-tight print:text-black">
          {trip.destination ?? trip.title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground print:text-neutral-700">
          {formatDateRange(trip.startDate, trip.endDate)}
          {trip.groupSize ? ` · ${trip.groupSize} players` : ""}
        </p>

        <article className="mt-10 leading-relaxed text-[15px] whitespace-pre-wrap print:text-black">
          {summary.content}
        </article>

        {highlights.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground print:text-neutral-600">
              Highlights
            </h2>
            <ul className="mt-3 space-y-2">
              {highlights.map((h, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <Check className="size-3.5 mt-1 text-[hsl(var(--emerald))] shrink-0 print:text-emerald-700" />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {substitutions.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground print:text-neutral-600">
              Substitutions made
            </h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground print:text-neutral-700">
              {substitutions.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span>·</span>
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-12">
          <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground print:text-neutral-600">
            Itinerary
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-3 print:gap-2">
            {summary.itinerary.items.map((i) => (
              <ItineraryItemCard
                key={i.id}
                compact
                item={{
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
                }}
              />
            ))}
          </div>
        </section>

        {summary.totalCost != null && (
          <footer className="mt-12 pt-6 border-t border-border flex items-center justify-between print:border-neutral-300">
            <p className="text-xs uppercase tracking-widest text-muted-foreground print:text-neutral-600">
              Trip total
            </p>
            <p className="text-display text-2xl num-tabular">
              {formatCurrency(summary.totalCost / 100)}
              {summary.perPersonCost != null && (
                <span className="text-muted-foreground text-sm font-normal ml-2">
                  ({formatCurrency(summary.perPersonCost / 100)} pp)
                </span>
              )}
            </p>
          </footer>
        )}

        <p className="mt-10 text-[11px] text-muted-foreground text-center print:text-neutral-600">
          Print → Save as PDF to keep a copy.
        </p>
      </div>
    </div>
  );
}
