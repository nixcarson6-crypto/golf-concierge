"use client";

/**
 * Danger zone — permanent account deletion. Two-step + type-to-confirm so it
 * can't be triggered by a stray click. On success the server has already
 * deleted the Clerk identity, so we just clear the local session and leave.
 */

import * as React from "react";
import { useClerk } from "@clerk/nextjs";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";

export function DangerZone() {
  const { signOut } = useClerk();
  const [expanded, setExpanded] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const del = async () => {
    if (busy || confirmText !== "DELETE") return;
    setBusy(true);
    try {
      const res = await fetch("/api/me", { method: "DELETE" });
      if (!res.ok) {
        toast.error(
          "Couldn't delete your account — try again, or email support@pyltrix.com.",
        );
        setBusy(false);
        return;
      }
      // Identity is gone server-side; drop the local session and go home.
      await signOut({ redirectUrl: "/" });
    } catch {
      toast.error("Network error — try again.");
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-destructive/30 bg-destructive/[0.03] p-6">
      <h2 className="text-sm font-medium text-destructive flex items-center gap-2">
        <AlertTriangle className="size-4" /> Danger zone
      </h2>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
        Permanently delete your Pyltrix account, your saved card, and every trip
        you&apos;ve planned. This can&apos;t be undone.
      </p>

      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition"
        >
          Delete account
        </button>
      ) : (
        <div className="mt-4 space-y-3">
          <label className="block text-xs text-muted-foreground">
            Type{" "}
            <span className="font-semibold text-destructive">DELETE</span> to
            confirm.
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void del();
              }}
              placeholder="DELETE"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-destructive transition"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={confirmText !== "DELETE" || busy}
              onClick={() => void del()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Permanently delete
            </button>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setConfirmText("");
              }}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
