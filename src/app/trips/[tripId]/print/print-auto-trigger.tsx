"use client";

import * as React from "react";

/**
 * Auto-fires the browser print dialog on mount so the customer lands
 * straight in "Save as PDF". A small delay lets fonts + layout settle
 * before we trigger — otherwise the first print sometimes captures
 * the page mid-render. Also renders an always-visible Print button
 * for when the auto-trigger gets blocked (some browsers / popup
 * blockers suppress programmatic print() if the user didn't initiate).
 */
export function PrintAutoTrigger() {
  React.useEffect(() => {
    const id = setTimeout(() => {
      try {
        window.print();
      } catch {
        // Some browsers (or extensions) block programmatic print —
        // the manual button below still works.
      }
    }, 400);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="no-print mb-6 flex items-center justify-between gap-3 rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3">
      <p className="text-sm text-neutral-700">
        Use your browser&apos;s print dialog to{" "}
        <strong>Save as PDF</strong>. If the dialog didn&apos;t open
        automatically, click Print.
      </p>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-lg bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
      >
        Print
      </button>
    </div>
  );
}
