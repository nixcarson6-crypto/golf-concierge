"use client";

import { Download } from "lucide-react";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="print:hidden inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border bg-surface-raised/40 hover:bg-surface-raised hover:border-foreground/20 transition"
    >
      <Download className="size-3.5" /> Save as PDF
    </button>
  );
}
