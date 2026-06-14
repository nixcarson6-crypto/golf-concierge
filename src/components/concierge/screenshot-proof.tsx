"use client";

/**
 * The screenshot the browser agent captured of the actual venue page — the
 * customer's tap-to-enlarge PROOF. Used both when a booking is CONFIRMED (the
 * venue's confirmation page) and while it's at the filled-in review / payment
 * step (the form Pyltrix completed on their behalf). Self-contained: a
 * thumbnail that opens a full-size dialog.
 */

import * as React from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function ScreenshotProof({
  url,
  title,
  caption,
}: {
  url: string;
  title: string;
  caption: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl overflow-hidden border border-foreground/30 hover:border-foreground/60 transition relative group"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={title}
          className="w-full h-auto object-cover max-h-44"
        />
        <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] uppercase tracking-widest text-center py-1.5">
          {caption}
        </div>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden">
          <div className="px-5 py-3 border-b border-border/40 flex items-center justify-between gap-3">
            <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="bg-black grid place-items-center max-h-[80vh] overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`${title} (full)`} className="w-full h-auto" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
