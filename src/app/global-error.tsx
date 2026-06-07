"use client";

import { useEffect } from "react";

/**
 * Last-resort error boundary. A normal `error.tsx` is rendered *inside* the
 * root layout, so it can't catch an error thrown by the root layout itself.
 * `global-error.tsx` replaces the entire document in that rare case, which
 * means it must render its own <html>/<body>.
 *
 * Kept deliberately dependency-free (no fonts, providers, or design-system
 * imports) so it still renders even if the failure is in app-shell setup.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/global-error-boundary]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          margin: 0,
          padding: "0 1rem",
          textAlign: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0b1220",
          color: "#e6eaf2",
        }}
      >
        <div style={{ maxWidth: "28rem" }}>
          <h1 style={{ fontSize: "1.875rem", fontWeight: 600, margin: 0 }}>
            We're reconnecting…
          </h1>
          <p style={{ marginTop: "0.75rem", color: "#9aa4b8" }}>
            Something interrupted the app. This is usually momentary — please
            try again.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1.5rem",
              height: "2.5rem",
              padding: "0 1.25rem",
              borderRadius: "0.75rem",
              border: "none",
              background: "#1d4ed8",
              color: "#fff",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
