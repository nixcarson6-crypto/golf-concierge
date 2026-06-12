import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { BadgeCheck, ListChecks, Sparkles, Wand2 } from "lucide-react";

export default function SignUpPage() {
  return (
    <div className="relative min-h-dvh flex flex-col bg-background overflow-hidden">
      {/* Same texture language as the landing: faint radial wash + hairline grid. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(70%_55%_at_50%_0%,hsl(var(--surface-sunken))_0%,transparent_62%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px)] [background-size:120px_100%]"
      />

      <header className="relative z-10 px-6 py-5 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <Link href="/" className="inline-flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-foreground">
            <svg
              viewBox="0 0 24 24"
              className="size-4 text-background"
              fill="currentColor"
              aria-hidden
            >
              <path d="M12 2c1.5 4 4 6.5 8 8-4 1.5-6.5 4-8 8-1.5-4-4-6.5-8-8 4-1.5 6.5-4 8-8Z" />
            </svg>
          </span>
          <span className="text-display text-lg tracking-tight">Pyltrix</span>
        </Link>
      </header>

      <main className="relative z-10 flex-1 grid place-items-center px-4 pb-14 pt-10">
        <div className="w-full max-w-md flex flex-col items-center gap-7">
          <div className="text-center space-y-2.5">
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-1.5 text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
                <span className="relative inline-flex size-1.5 rounded-full bg-foreground" />
              </span>
              Invite-only beta
            </p>
            <h1 className="text-display text-[2rem] tracking-tight text-foreground">
              Plan your trip.
            </h1>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Answer a few questions and our AI builds your complete golf
              trip — then books the whole thing for you.
            </p>
          </div>

          <SignUp
            appearance={{
              elements: { rootBox: "w-full" },
            }}
          />

          <p className="text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-foreground underline underline-offset-4 hover:opacity-70 font-medium"
            >
              Sign in
            </Link>
          </p>

          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12px] text-muted-foreground border-t border-border/60 pt-5 w-full">
            <li className="flex items-center gap-1.5">
              <ListChecks className="size-3.5" strokeWidth={2} />
              One short quiz
            </li>
            <li className="flex items-center gap-1.5">
              <Wand2 className="size-3.5" strokeWidth={2} />
              AI builds it
            </li>
            <li className="flex items-center gap-1.5">
              <BadgeCheck className="size-3.5" strokeWidth={2} />
              Booked for real
            </li>
            <li className="flex items-center gap-1.5">
              <Sparkles className="size-3.5" strokeWidth={2} />
              You just show up
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
