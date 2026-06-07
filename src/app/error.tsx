"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Route-segment error boundary. Next.js renders this whenever a Server
 * Component (or its data fetching) throws during render — most importantly
 * a transient database outage (e.g. Neon compute waking from auto-suspend,
 * or a brief connection RST). Without this boundary those failures bubble
 * up as a raw, unrecoverable 500 / React error overlay.
 *
 * The "Try again" button calls `reset()`, which re-renders the failed
 * segment. Combined with the auto-retry baked into `src/lib/db.ts`, a
 * momentary DB blip becomes a one-click (or zero-click, on the next
 * navigation) recovery instead of a dead page.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the server/observability logs without crashing the client.
    console.error("[app/error-boundary]", error);
  }, [error]);

  const isConnectivity = looksLikeDbOutage(error);

  return (
    <div className="min-h-dvh grid place-items-center px-4 bg-concierge-radial text-center">
      <div className="max-w-md">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {isConnectivity ? "Temporarily unavailable" : "Something went wrong"}
        </p>
        <h1 className="mt-2 text-display text-4xl tracking-tight">
          {isConnectivity
            ? "We're reconnecting…"
            : "That didn't go to plan."}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {isConnectivity
            ? "We couldn't reach the database just now. This is usually momentary — give it a second and try again."
            : "An unexpected error interrupted this page. You can try again, or head back to your dashboard."}
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="navy" onClick={() => reset()}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Best-effort detection of a database-connectivity failure so we can show a
 * reassuring "reconnecting" message rather than a generic error. In
 * production Next.js scrubs Server Component error messages (leaving only a
 * `digest`), so this reliably matches in dev / self-hosted logs and falls
 * back gracefully to the generic copy when the message is unavailable.
 */
function looksLikeDbOutage(error: Error & { digest?: string }): boolean {
  const msg = `${error?.message ?? ""}`;
  return (
    msg.includes("Can't reach database server") ||
    msg.includes("database server") ||
    msg.includes("ECONNRESET") ||
    msg.includes("Connection terminated") ||
    msg.includes("Connection reset") ||
    msg.includes("Closed") ||
    msg.includes("prisma")
  );
}
