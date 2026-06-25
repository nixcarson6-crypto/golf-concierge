"use client";

/**
 * On-brand replacement for Clerk's <UserButton>, whose default avatar is a
 * purple gradient identicon that clashes with the ivory/ink/green theme.
 * Renders a clean initials circle (or the real profile photo when there is
 * one) that opens a small menu headed with WHO you're signed in as, so it's
 * never a mystery letter — then Settings / Sign out.
 *
 * Pass `name`/`email` from the server (the authoritative DB user) so the
 * initials + identity are always right even before Clerk's client user
 * hydrates; falls back to Clerk's useUser() when a caller omits them.
 */

import * as React from "react";
import Link from "next/link";
import { useUser, useClerk } from "@clerk/nextjs";

export function AccountButton({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
} = {}) {
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

  // Prefer the authoritative server values; fall back to Clerk's client user.
  const displayName =
    name ||
    user?.fullName ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    null;
  const displayEmail = email || user?.primaryEmailAddress?.emailAddress || null;
  const initials = initialsFrom(displayName, displayEmail);
  const showImage = Boolean(user?.hasImage && user?.imageUrl);

  // Founder sees the concierge queue link (the page itself is server-gated too).
  const isFounder =
    (displayEmail ?? "").toLowerCase() === "nixcarson6@gmail.com";

  const itemCls =
    "block w-full text-left px-3 py-2 text-sm text-foreground/90 hover:bg-surface-raised transition";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Your account"
        title={displayName ?? displayEmail ?? "Your account"}
        className="grid size-9 place-items-center overflow-hidden rounded-full bg-foreground text-background text-xs font-semibold tracking-wide hover:opacity-90 transition"
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user!.imageUrl} alt="" className="size-full object-cover" />
        ) : (
          initials
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-60 rounded-xl border border-border/60 bg-background shadow-lg py-1 z-50">
          {/* Identity header — answers "whose account is this?" at a glance. */}
          <div className="px-3 py-2.5 border-b border-border/60">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Signed in as
            </p>
            {displayName && (
              <p className="text-sm font-medium truncate">{displayName}</p>
            )}
            {displayEmail && (
              <p className="text-xs text-muted-foreground truncate">
                {displayEmail}
              </p>
            )}
          </div>
          {isFounder && (
            <Link
              href="/admin/queue"
              onClick={() => setOpen(false)}
              className={itemCls}
            >
              Concierge queue
            </Link>
          )}
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className={itemCls}
          >
            Settings
          </Link>
          <button
            type="button"
            onClick={() => void signOut({ redirectUrl: "/" })}
            className={itemCls}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** "Carson Nix" → "CN"; else first letter of the email; else a neutral dot. */
function initialsFrom(name?: string | null, email?: string | null): string {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    const ini = (first + last).toUpperCase();
    if (ini) return ini;
  }
  const e = (email ?? "").trim();
  if (e) return e[0]!.toUpperCase();
  return "·";
}
