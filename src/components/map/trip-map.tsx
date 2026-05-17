"use client";

import * as React from "react";
import { APIProvider, Map, AdvancedMarker, Pin } from "@vis.gl/react-google-maps";
import type { ItineraryItemType } from "@prisma/client";
import { Sparkles, MapPin } from "lucide-react";

const DARK_MAP_ID = "golf-concierge-dark";

export type MapPoint = {
  id: string;
  title: string;
  type: ItineraryItemType;
  lat: number;
  lng: number;
};

export function TripMap({
  apiKey,
  points,
  fallback,
}: {
  apiKey: string | null;
  points: MapPoint[];
  fallback: Array<{
    id: string;
    title: string;
    type: ItineraryItemType;
    location: string | null;
    startTime: string | null;
  }>;
}) {
  if (!apiKey || points.length === 0) {
    return <MapFallback fallback={fallback} reason={!apiKey ? "missing-key" : "no-coords"} />;
  }

  const center = {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };

  return (
    <div className="rounded-3xl overflow-hidden border border-border h-[70dvh]">
      <APIProvider apiKey={apiKey}>
        <Map
          mapId={DARK_MAP_ID}
          defaultCenter={center}
          defaultZoom={11}
          gestureHandling="greedy"
          disableDefaultUI
          colorScheme="DARK"
        >
          {points.map((p) => (
            <AdvancedMarker key={p.id} position={{ lat: p.lat, lng: p.lng }}>
              <Pin
                background="#d6b274"
                borderColor="#15110a"
                glyphColor="#15110a"
              />
            </AdvancedMarker>
          ))}
        </Map>
      </APIProvider>
    </div>
  );
}

function MapFallback({
  fallback,
  reason,
}: {
  fallback: Array<{
    id: string;
    title: string;
    type: ItineraryItemType;
    location: string | null;
    startTime: string | null;
  }>;
  reason: "missing-key" | "no-coords";
}) {
  if (fallback.length === 0) {
    return (
      <div className="glass rounded-3xl p-12 text-center">
        <Sparkles className="mx-auto size-5 text-[hsl(var(--gold))]" />
        <p className="mt-3 text-sm text-muted-foreground">
          Once the itinerary is drafted, locations appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="glass rounded-3xl p-6">
      <p className="text-xs text-muted-foreground mb-3">
        {reason === "missing-key"
          ? "Add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable the map view. Itinerary locations below."
          : "Geocoding coming once partners return coordinates. Itinerary locations below."}
      </p>
      <ul className="divide-y divide-border/60">
        {fallback.map((i) => (
          <li key={i.id} className="py-3 flex items-center gap-3">
            <MapPin className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-tight">{i.title}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {i.location ?? "Location TBD"}
              </p>
            </div>
            {i.startTime && (
              <span className="text-[11px] text-muted-foreground num-tabular">
                {new Date(i.startTime).toLocaleString("en-US", {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
