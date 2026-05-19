/**
 * Tiny in-process pub/sub for live trip updates.
 *
 * The workspace SSE endpoint subscribes per trip, and any mutation that
 * affects the snapshot (chat message persisted, agent run progress,
 * itinerary version created, payment status change) calls `emitTripEvent`
 * to nudge subscribers to refetch.
 *
 * In-process is fine for single-instance Vercel + Node functions; scale-out
 * deployments swap this for Redis pub/sub or Supabase realtime without
 * touching call sites.
 */

type Listener = (event: TripEvent) => void;

export type TripEvent =
  | { kind: "snapshot.changed"; tripId: string }
  | { kind: "agent.progress"; tripId: string; runId: string; progress: string }
  | { kind: "notification"; tripId: string; userId: string };

const subscribers = new Map<string, Set<Listener>>();

export function subscribeTrip(tripId: string, listener: Listener) {
  let set = subscribers.get(tripId);
  if (!set) {
    set = new Set();
    subscribers.set(tripId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) subscribers.delete(tripId);
  };
}

export function emitTripEvent(event: TripEvent) {
  const set = subscribers.get(event.tripId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch (err) {
      console.error("[events] listener threw", err);
    }
  }
}

/** Helper: snapshot-changed shorthand for the common case. */
export function nudge(tripId: string) {
  emitTripEvent({ kind: "snapshot.changed", tripId });
}
