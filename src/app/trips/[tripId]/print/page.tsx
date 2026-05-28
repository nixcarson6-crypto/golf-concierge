import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { formatDateRange } from "@/lib/utils";
import { PrintAutoTrigger } from "./print-auto-trigger";

export const dynamic = "force-dynamic";

/**
 * Print-optimised day-by-day view of a trip. Opened in a new tab from the
 * "Download day-by-day PDF" button on the result page; the embedded
 * <PrintAutoTrigger /> fires window.print() on mount so the customer
 * lands directly in the system print dialog where "Save as PDF" is one
 * click away. No external PDF library — the browser does the rendering.
 */
export default async function PrintPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  try {
    await requireTripAccess(tripId);
  } catch {
    notFound();
  }

  const trip = await db.trip.findUnique({ where: { id: tripId } });
  if (!trip) notFound();

  const itinerary = await db.itinerary.findFirst({
    where: {
      tripId,
      status: { in: ["DRAFT", "CURRENT", "APPROVED"] },
    },
    include: { items: { orderBy: { orderIndex: "asc" } } },
    orderBy: { version: "desc" },
  });

  // Group items by date so the printed page reads chronologically — same
  // grouping the old day-by-day on-screen view used.
  type Item = NonNullable<typeof itinerary>["items"][number];
  const byDay = new Map<string, Item[]>();
  if (itinerary) {
    for (const it of itinerary.items) {
      const dayKey = it.startTime
        ? new Date(it.startTime).toISOString().slice(0, 10)
        : "no-date";
      const list = byDay.get(dayKey) ?? [];
      list.push(it);
      byDay.set(dayKey, list);
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => {
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return a.startTime.getTime() - b.startTime.getTime();
      });
    }
  }
  const sortedDays = [...byDay.entries()].sort(([a], [b]) => {
    if (a === "no-date") return 1;
    if (b === "no-date") return -1;
    return a.localeCompare(b);
  });

  const fmtDay = (key: string): string => {
    if (key === "no-date") return "Trip plan";
    const d = new Date(key);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const fmtTime = (iso: Date | null): string | null => {
    if (!iso) return null;
    return iso.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="print-root mx-auto max-w-[800px] bg-white text-black p-10 font-sans">
      <PrintAutoTrigger />

      <style>{`
        @page { margin: 0.6in; }
        @media print {
          html, body { background: white !important; }
          .no-print { display: none !important; }
          .print-day { break-inside: avoid; page-break-inside: avoid; }
        }
        .print-root { color: #111; }
      `}</style>

      <header className="border-b-2 border-black pb-4 mb-6">
        <p className="text-xs uppercase tracking-widest text-neutral-600">
          Pyltrix · Trip Itinerary
        </p>
        <h1 className="text-3xl font-semibold mt-1">
          {trip.destination ?? trip.title ?? "Your trip"}
        </h1>
        <p className="text-sm text-neutral-700 mt-1">
          {trip.startDate
            ? formatDateRange(trip.startDate, trip.endDate ?? null)
            : "Dates TBD"}
          {trip.groupSize ? ` · ${trip.groupSize} players` : ""}
        </p>
      </header>

      {!itinerary || sortedDays.length === 0 ? (
        <p className="text-sm text-neutral-700">
          No itinerary yet — finish building the trip first, then come back
          to download.
        </p>
      ) : (
        <div className="space-y-6">
          {sortedDays.map(([dayKey, items]) => (
            <section key={dayKey} className="print-day">
              <h2 className="text-lg font-semibold border-b border-neutral-300 pb-1 mb-3">
                {fmtDay(dayKey)}
              </h2>
              <ul className="space-y-3">
                {items.map((it) => {
                  const time = fmtTime(it.startTime);
                  return (
                    <li key={it.id} className="text-sm">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs uppercase tracking-wider text-neutral-500 shrink-0 w-20">
                          {time ?? it.type.toLowerCase().replace("_", " ")}
                        </span>
                        <div className="flex-1">
                          <p className="font-medium">{it.title}</p>
                          {it.location && (
                            <p className="text-neutral-600 text-xs">
                              {it.location}
                            </p>
                          )}
                          {it.description && (
                            <p className="text-neutral-700 text-xs mt-0.5">
                              {it.description}
                            </p>
                          )}
                          {it.cost != null && it.cost > 0 && (
                            <p className="text-neutral-600 text-xs mt-0.5">
                              ${Math.round(it.cost / 100).toLocaleString()}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <footer className="mt-10 pt-4 border-t border-neutral-300 text-xs text-neutral-500">
        Generated by Pyltrix · {new Date().toLocaleDateString()}
      </footer>
    </div>
  );
}
