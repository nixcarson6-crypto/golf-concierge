import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { Button } from "@/components/ui/button";

export default async function LandingPage() {
  const { userId } = await auth();
  // "Start a trip" jumps straight to a fresh quiz when signed in
  // (/trips/new seeds a DRAFT then redirects into the questions). Signed
  // out → /sign-up, which bounces back here after auth.
  const primaryHref = userId ? "/trips/new" : "/sign-up";

  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      {/* ---------------------------------------------------------------- nav */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <nav className="container flex items-center justify-between py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-1.5">
            {userId ? (
              <Button asChild size="sm">
                <Link href="/dashboard">
                  Dashboard <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/sign-up">Get started</Link>
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>

      {/* -------------------------------------------------------------- hero */}
      <section className="container pt-20 pb-24 sm:pt-28 sm:pb-32">
        <p className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-foreground" />
          AI luxury golf-travel concierge
        </p>
        <h1 className="mt-7 text-display text-[2.75rem] leading-[1.04] tracking-[-0.03em] sm:text-7xl max-w-4xl">
          The trip you&apos;d ask a private concierge to plan —
          <span className="text-muted-foreground"> booked end to end.</span>
        </h1>
        <p className="mt-7 max-w-xl text-base sm:text-lg text-muted-foreground leading-relaxed">
          Answer a few questions. Our AI builds a complete, bookable golf
          trip — flights, lodging, tee times, dining, and transport — then
          books the whole thing for you. You just show up.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button asChild size="lg" className="h-12 px-6">
            <Link href={primaryHref}>
              Plan my trip <ArrowRight className="ml-1 size-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="h-12 px-6">
            <Link href="#how">How it works</Link>
          </Button>
        </div>

        {/* Stat strip — hairline-separated, monochrome */}
        <div className="mt-20 grid grid-cols-2 sm:grid-cols-4 border-t border-border">
          {STATS.map((s) => (
            <div
              key={s.label}
              className="py-6 sm:py-7 pr-6 border-b border-border sm:border-b-0 sm:border-r last:border-r-0"
            >
              <p className="text-display text-3xl sm:text-4xl tracking-tight tabular-nums">
                {s.value}
              </p>
              <p className="mt-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------- how it works */}
      <section id="how" className="border-t border-border bg-surface-sunken/40">
        <div className="container py-24">
          <div className="max-w-2xl">
            <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              How it works
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight">
              Three steps. Zero spreadsheets.
            </h2>
          </div>
          <div className="mt-14 grid gap-px sm:grid-cols-3 bg-border border border-border rounded-2xl overflow-hidden">
            {STEPS.map((step, i) => (
              <div key={step.title} className="bg-background p-8 sm:p-10">
                <p className="text-display text-2xl text-muted-foreground tabular-nums">
                  0{i + 1}
                </p>
                <h3 className="mt-6 text-lg font-medium tracking-tight">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- feature grid */}
      <section className="container py-24">
        <div className="max-w-2xl">
          <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
            What you get
          </p>
          <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight">
            A real trip, not a list of links.
          </h2>
        </div>
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border rounded-2xl overflow-hidden">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-background p-8 group">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-medium tracking-tight">
                  {f.title}
                </h3>
                <ArrowUpRight className="size-4 text-muted-foreground/40 group-hover:text-foreground transition" />
              </div>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------------- closing CTA */}
      <section className="container pb-24">
        <div className="rounded-3xl bg-foreground text-background px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display text-3xl sm:text-5xl tracking-tight max-w-3xl mx-auto leading-[1.08]">
            Tell us where you want to play. We&apos;ll handle the rest.
          </h2>
          <div className="mt-10">
            <Button
              asChild
              size="lg"
              className="h-12 px-7 bg-background text-foreground hover:bg-background/90"
            >
              <Link href={primaryHref}>
                Plan my trip <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- footer */}
      <footer className="border-t border-border">
        <div className="container py-8 flex items-center justify-between text-sm text-muted-foreground">
          <Wordmark small />
          <span>© {new Date().getFullYear()} Pyltrix</span>
        </div>
      </footer>
    </main>
  );
}

const STATS = [
  { value: "1 pass", label: "Whole trip built" },
  { value: "End→end", label: "Booked for you" },
  { value: "5★", label: "Luxury markets" },
  { value: "0", label: "Spreadsheets" },
];

const STEPS = [
  {
    title: "Answer the quiz",
    body: "A few quick questions — where, when, who, the vibe, the budget. No forms, no back-and-forth.",
  },
  {
    title: "AI builds the trip",
    body: "Flights, lodging, tee times, dining, and ground transport — a complete day-by-day itinerary with real, current prices.",
  },
  {
    title: "We book it all",
    body: "One tap. Our concierge agent reserves everything on your behalf and hands you the confirmations. You just show up.",
  },
];

const FEATURES = [
  {
    title: "Real prices, never guessed",
    body: "Live flight fares, published hotel and green-fee rates, and ride costs from actual driving distance. If we can't confirm it, we don't show it.",
  },
  {
    title: "Fastest routes, automatically",
    body: "Flights ranked by speed and stops, not just price — the nonstop a private concierge would put you on.",
  },
  {
    title: "Books the long tail",
    body: "Independent courses, beach clubs, spas, boat tours — anything with a booking page, our agent reserves directly on the venue's own site.",
  },
  {
    title: "Marquee dining, handled",
    body: "The restaurants you actually want, reserved or one tap away — no phone tag, no guesswork.",
  },
  {
    title: "Proof you can see",
    body: "Every booking comes back with a real confirmation number and the venue's own confirmation page. Zero-click peace of mind.",
  },
  {
    title: "Swap anything, instantly",
    body: "Don't love a pick? Tap for an alternative. The plan and the totals rebuild on the spot.",
  },
];

function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2">
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
      <span
        className={
          small
            ? "text-display text-base tracking-tight"
            : "text-display text-lg tracking-tight"
        }
      >
        Pyltrix
      </span>
    </span>
  );
}
