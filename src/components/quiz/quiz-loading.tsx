"use client";

import * as React from "react";

const FALLBACK_STATUSES = [
  "Analysing your preferences…",
  "Matching destinations…",
  "Pulling live flight inventory…",
  "Checking course availability…",
  "Sourcing lodging…",
  "Building your itinerary…",
  "Almost there — putting it all together…",
];

/**
 * Animated loading screen shown after the user finishes the quiz and we
 * call /build. When given a tripId, polls /workspace every 2s and shows
 * the live agentRun progress so the user sees what's ACTUALLY happening
 * on the server. Falls back to rotating placeholder text before the
 * first agent run is written or if polling fails.
 *
 * Also adapts the helper text after 60s / 150s so customers on big
 * multi-leg builds don't think the page died.
 */
export function QuizLoading({ tripId }: { tripId?: string }) {
  const [idx, setIdx] = React.useState(0);
  const [liveProgress, setLiveProgress] = React.useState<string | null>(null);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % FALLBACK_STATUSES.length);
    }, 2200);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll the workspace endpoint for real agent progress. The most
  // recent agentRun with status RUNNING is what the server is doing
  // right now — its `progress` field is set by withAgentRun for every
  // phase (destination, itinerary, flight search, etc.).
  React.useEffect(() => {
    if (!tripId) return;
    let stopped = false;
    const tick = async () => {
      try {
        // Poll the ultra-light progress endpoint (one DB query) — NOT the
        // heavy /workspace snapshot. During a build the connection pool is
        // tiny and the build needs it; hammering /workspace here used to
        // starve the build itself on slow connections.
        const r = await fetch(`/api/trips/${tripId}/progress`, {
          cache: "no-store",
        });
        if (!r.ok || stopped) return;
        const data = (await r.json()) as {
          progress?: string | null;
          agentStatus?: string | null;
        };
        if (data.progress) setLiveProgress(data.progress);
      } catch {
        // Ignore — keep showing the rotating fallback.
      }
    };
    void tick();
    // 4s poll against the light endpoint — cheap enough to feel live
    // without competing with the build for the connection pool.
    const id = setInterval(tick, 4000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [tripId]);

  const status = liveProgress ?? FALLBACK_STATUSES[idx];

  return (
    <div className="min-h-dvh bg-concierge-radial grid place-items-center px-4">
      <div className="text-center space-y-8 max-w-md">
        <div className="relative size-20 mx-auto">
          <span className="absolute inset-0 rounded-full bg-[hsl(var(--copper))]/20 animate-ping" />
          <span className="absolute inset-2 rounded-full bg-[hsl(var(--copper))]/40 animate-pulse" />
          <span className="absolute inset-5 rounded-full bg-[hsl(var(--copper))]" />
        </div>
        <div className="space-y-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            Building your trip
          </h2>
          <p
            key={status}
            className="text-base text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-500"
          >
            {status}
          </p>
        </div>
        <p className="text-xs text-muted-foreground/70 max-w-xs mx-auto">
          {elapsed < 60
            ? "This usually takes 10–25 seconds. We're pulling live data from every partner — flights, lodging, courses, dining — so the plan is actually bookable."
            : elapsed < 150
              ? "Complex multi-destination trips can take 1–3 minutes. We're still working — hang tight."
              : elapsed < 300
                ? "Big multi-leg trips or slow networks can push this past 5 minutes. Still working — don't refresh."
                : "This is taking longer than usual. We'll automatically time out at 8 minutes; refresh and try a simpler request if it doesn't finish."}
        </p>
      </div>
    </div>
  );
}
