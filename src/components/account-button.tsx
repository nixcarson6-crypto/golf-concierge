"use client";

/**
 * On-brand replacement for Clerk's <UserButton>, whose default avatar is a
 * purple gradient identicon that clashes with the ivory/ink/green theme.
 * Renders a clean initials circle that opens a tiny Settings / Sign out menu.
 */

import * as React from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";

export function AccountButton() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const initials =
    `${user?.firstName?.[0] ?? ""}${user?.lastName?.[0] ?? ""}`.toUpperCase() ||
    user?.primaryEmailAddress?.emailAddress?.[0]?.toUpperCase() ||
    "·";
  // Founder sees the concierge queue link (the page itself is server-gated too).
  const isFounder =
    user?.primaryEmailAddress?.emailAddress?.toLowerCase() ===
    "nixcarson6@gmail.com";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        className="grid size-9 place-items-center rounded-full bg-foreground text-background text-xs font-semibold tracking-wide hover:opacity-90 transition"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-44 rounded-xl border border-border/60 bg-background shadow-lg py-1 z-50">
          {isFounder && (
            <Link
              href="/admin/queue"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-foreground/90 hover:bg-surface-raised transition"
            >
              Concierge queue
            </Link>
          )}
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-foreground/90 hover:bg-surface-raised transition"
          >
            Settings
          </Link>
          <button
            type="button"
            onClick={() => void signOut({ redirectUrl: "/" })}
            className="block w-full text-left px-3 py-2 text-sm text-foreground/90 hover:bg-surface-raised transition"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
