import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";
import { TripMap } from "@/components/map/trip-map";

export const dynamic = "force-dynamic";

export default async function MapPage({
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
    include: { items: { orderBy: { orderIndex: "asc" } } },
  });

  const apiKey = optionalEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY") ?? null;

  const points = (itinerary?.items ?? [])
    .filter((i) => i.latitude != null && i.longitude != null)
    .map((i) => ({
      id: i.id,
      title: i.title,
      type: i.type,
      lat: i.latitude!,
      lng: i.longitude!,
    }));

  const fallback = (itinerary?.items ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type,
    location: i.location ?? null,
    startTime: i.startTime?.toISOString() ?? null,
  }));

  return (
    <div className="container py-8">
      <div className="max-w-2xl mb-6">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Map
        </p>
        <h1 className="mt-1 text-display text-3xl tracking-tight">
          See it geographically.
        </h1>
      </div>
      <TripMap apiKey={apiKey} points={points} fallback={fallback} />
    </div>
  );
}
