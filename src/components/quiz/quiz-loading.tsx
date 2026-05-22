"use client";

import * as React from "react";

const STATUSES = [
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
 * call /build. The rotating status text is Hungry Root's trick to make
 * the personalisation moment feel substantive (and to mask the actual
 * 10–25 second AI latency without staring at a spinner).
 */
export function QuizLoading() {
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % STATUSES.length);
    }, 2200);
    return () => clearInterval(id);
  }, []);

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
            key={idx}
            className="text-base text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-500"
          >
            {STATUSES[idx]}
          </p>
        </div>
        <p className="text-xs text-muted-foreground/70 max-w-xs mx-auto">
          This usually takes 10–25 seconds. We're pulling live data from every
          partner — flights, lodging, courses, dining — so the plan is
          actually bookable.
        </p>
      </div>
    </div>
  );
}
