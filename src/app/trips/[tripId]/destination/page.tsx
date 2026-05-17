import { notFound } from "next/navigation";
import Image from "next/image";
import { Sparkles, Check } from "lucide-react";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { SelectDestinationButton } from "./select-button";

export const dynamic = "force-dynamic";

export default async function DestinationsPage({
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

  const options = await db.destinationOption.findMany({
    where: { tripId: trip.id },
    orderBy: { rank: "asc" },
  });

  return (
    <div className="container py-8">
      <div className="max-w-2xl">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Destinations
        </p>
        <h1 className="mt-1 text-display text-3xl tracking-tight">
          {options.length === 0
            ? "Awaiting your first brief"
            : "Three honest options."}
        </h1>
        <p className="mt-2 text-muted-foreground">
          Scored on golf quality, nightlife, and travel logistics. The strongest fit
          is first — your concierge has reasons.
        </p>
      </div>

      {options.length === 0 ? (
        <div className="mt-12 glass rounded-3xl p-12 text-center max-w-xl mx-auto">
          <Sparkles className="mx-auto size-5 text-[hsl(var(--gold))]" />
          <p className="mt-4 text-sm text-muted-foreground">
            Once we know your group, dates, and budget, destinations appear here.
          </p>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {options.map((d, i) => (
            <article
              key={d.id}
              className="glass rounded-3xl overflow-hidden flex flex-col"
            >
              <div className="relative aspect-[16/10] bg-surface-raised">
                {d.heroImageUrl && (
                  <Image
                    src={d.heroImageUrl}
                    alt={d.name}
                    fill
                    sizes="(max-width: 768px) 100vw, 33vw"
                    className="object-cover"
                    unoptimized
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
                <div className="absolute top-3 left-3 flex gap-1.5">
                  {i === 0 && (
                    <Badge variant="gold" size="sm">
                      <Sparkles className="size-3" /> Top pick
                    </Badge>
                  )}
                  {d.selected && (
                    <Badge variant="emerald" size="sm">
                      <Check className="size-3" /> Selected
                    </Badge>
                  )}
                </div>
                <div className="absolute bottom-3 left-3 right-3">
                  <h3 className="text-display text-2xl tracking-tight">{d.name}</h3>
                  <p className="text-xs text-muted-foreground">{d.weatherSummary}</p>
                </div>
              </div>

              <div className="flex-1 p-5 space-y-4">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {d.description}
                </p>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <ScoreCell label="Golf" value={d.golfScore} accent="emerald" />
                  <ScoreCell label="Nightlife" value={d.nightlifeScore} accent="gold" />
                  <ScoreCell label="Logistics" value={d.logisticsScore} accent="muted" />
                </div>

                <div className="rounded-xl border border-border/60 bg-surface-raised/30 px-3.5 py-2.5 text-xs">
                  <p className="text-muted-foreground uppercase tracking-wider text-[10px]">
                    Lodging
                  </p>
                  <p className="mt-0.5">{d.lodgingEstimate}</p>
                </div>

                <div className="rounded-xl border border-border/60 bg-surface-raised/40 p-3 text-xs leading-relaxed text-muted-foreground flex gap-2 items-start">
                  <Sparkles className="size-3 mt-0.5 text-[hsl(var(--gold))] shrink-0" />
                  <span>{d.aiExplanation}</span>
                </div>

                <div className="flex items-end justify-between">
                  <div className="num-tabular">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Per person
                    </p>
                    <p className="text-lg">
                      {formatCurrency(d.estimatedPerPersonCost / 100)}
                    </p>
                  </div>
                  <SelectDestinationButton
                    tripId={trip.id}
                    destinationId={d.id}
                    selected={d.selected}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "gold" | "emerald" | "muted";
}) {
  const colour =
    accent === "gold"
      ? "text-[hsl(var(--gold))]"
      : accent === "emerald"
        ? "text-[hsl(var(--emerald))]"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-surface-raised/40 px-2.5 py-2 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={`mt-0.5 text-lg num-tabular ${colour}`}>{value}</p>
    </div>
  );
}
