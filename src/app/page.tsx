import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BedDouble,
  CalendarCheck2,
  Car,
  CheckCheck,
  Flag,
  ListChecks,
  MapPin,
  Plane,
  ReceiptText,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  UtensilsCrossed,
  Wand2,
} from "lucide-react";
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
                  <Link href="/sign-up">Get early access</Link>
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>

      {/* -------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        {/* Faint radial wash + hairline grid so the hero isn't a flat void. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background:radial-gradient(80%_60%_at_70%_0%,hsl(var(--surface-sunken))_0%,transparent_60%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px)] [background-size:120px_100%]"
        />
        <div className="container relative grid items-center gap-16 pt-16 pb-20 sm:pt-24 sm:pb-28 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="rise rise-1 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-[11px] uppercase tracking-[0.28em] text-accent">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/40" />
                <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
              </span>
              Launching soon · invite-only
            </p>
            <h1 className="rise rise-2 mt-8 text-display text-[2.85rem] leading-[1.03] tracking-[-0.035em] sm:text-6xl lg:text-[4.4rem]">
              The golf trip you keep talking about —
              <em className="text-accent font-light"> planned in minutes.</em>
            </h1>
            <p className="rise rise-3 mt-7 max-w-xl text-base sm:text-lg text-muted-foreground leading-relaxed">
              Answer a few questions and Pyltrix&apos;s AI designs your
              complete luxury golf trip — flights, lodging, tee times, dining,
              and transport — at real, current prices. We book your flights and
              your stay, you pick your tee times, and we line up the rest.
            </p>
            <div className="rise rise-4 mt-10 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="h-12 px-7">
                <Link href={primaryHref}>
                  Plan my trip <ArrowRight className="ml-1.5 size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-12 px-6">
                <Link href="#how">How it works</Link>
              </Button>
            </div>
            <ul className="rise rise-5 mt-12 flex flex-wrap gap-x-7 gap-y-3 text-[13px] text-muted-foreground">
              {ASSURANCES.map((a) => (
                <li key={a} className="flex items-center gap-2">
                  <CheckCheck className="size-3.5 text-accent" />
                  {a}
                </li>
              ))}
            </ul>
          </div>

          {/* The product, not a screenshot: a real-shaped itinerary card. */}
          <div className="rise rise-3 relative mx-auto w-full max-w-[460px] lg:max-w-none">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-[2rem] bg-accent/[0.06] blur-2xl"
            />
            <div className="float-soft">
              <TripCard />
            </div>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              A complete trip Pyltrix planned in one pass — real flights, real
              rates, ready to book.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------- destinations strip */}
      <section className="border-y border-border bg-surface-sunken/40">
        <div className="container flex flex-wrap items-center justify-center gap-x-10 gap-y-3 py-6 text-[13px] uppercase tracking-[0.22em] text-muted-foreground">
          {DESTINATIONS.map((d, i) => (
            <span key={d} className="flex items-center gap-10">
              {i > 0 && (
                <span aria-hidden className="hidden sm:inline text-border">
                  ·
                </span>
              )}
              <span className="flex items-center gap-2">
                <MapPin className="size-3.5 opacity-50" />
                {d}
              </span>
            </span>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- watch it book */}
      <section className="bg-[#121511] text-[#f2f1ea]">
        <div className="container grid items-center gap-16 py-24 sm:py-28 lg:grid-cols-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#7f8378]">
              Booking your stay
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight leading-[1.06]">
              We book it, line by line.
            </h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-[#b5b8ae]">
              For your hotel, Pyltrix doesn&apos;t just hand you a link. Its
              booking agent works the property&apos;s own site — dates, room,
              your details — and we stand behind every reservation until
              it&apos;s confirmed under your name.
            </p>
          </div>
          <div className="rounded-xl border border-[#2a2e28] bg-[#0c0f0b] shadow-[0_40px_80px_-40px_rgb(0_0_0/0.6)] overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[#2a2e28] px-4 py-3 font-mono text-[11px] text-[#7f8378]">
              <span className="flex gap-1.5 mr-2">
                <i className="block size-2 rounded-full bg-[#2e332c]" />
                <i className="block size-2 rounded-full bg-[#2e332c]" />
                <i className="block size-2 rounded-full bg-[#2e332c]" />
              </span>
              pyltrix · booking one&amp;only portonovi
            </div>
            <div className="px-5 py-5 font-mono text-[12.5px] leading-[2.15]">
              {BOOKING_LOG.map((l, i) => (
                <div key={l.msg} className={`rise rise-${Math.min(i + 1, 5)} flex gap-3.5 whitespace-nowrap`}>
                  <span className="w-12 shrink-0 text-[#5d6157]">{l.t}</span>
                  <span className="text-[#69b489]">✓</span>
                  <span className={i === BOOKING_LOG.length - 1 ? "font-medium text-[#f2f1ea]" : "text-[#c9ccc0] overflow-hidden text-ellipsis"}>
                    {l.msg}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- how it works */}
      <section id="how" className="container py-24 sm:py-28">
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
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl border border-border bg-surface-sunken/50">
                  <step.icon className="size-5 text-accent" strokeWidth={1.75} />
                </span>
                <p className="text-display text-2xl text-accent/60 tabular-nums">
                  0{i + 1}
                </p>
              </div>
              <h3 className="mt-7 text-lg font-medium tracking-tight">
                {step.title}
              </h3>
              <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------- feature grid */}
      <section className="border-t border-border bg-surface-sunken/40">
        <div className="container py-24 sm:py-28">
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
              <div key={f.title} className="group bg-background p-8 hover-lift">
                <div className="flex items-start justify-between">
                  <span className="grid size-10 place-items-center rounded-lg border border-border bg-surface-sunken/50">
                    <f.icon className="size-[18px] text-accent" strokeWidth={1.75} />
                  </span>
                  <ArrowUpRight className="size-4 text-muted-foreground/30 transition group-hover:text-foreground" />
                </div>
                <h3 className="mt-6 text-base font-medium tracking-tight">
                  {f.title}
                </h3>
                <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ proof section */}
      <section className="container py-24 sm:py-28">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              Booked means booked
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight leading-[1.08]">
              Every reservation comes with receipts.
            </h2>
            <p className="mt-6 max-w-lg text-base text-muted-foreground leading-relaxed">
              When Pyltrix books a venue, you get the venue&apos;s own
              confirmation — number, amount, and a capture of their
              confirmation page. The reservation sits in{" "}
              <em className="not-italic font-medium text-foreground">
                their
              </em>{" "}
              system under your name, so the front desk already knows
              you&apos;re coming.
            </p>
            <ul className="mt-8 space-y-4">
              {PROOFS.map((p) => (
                <li key={p.title} className="flex gap-3.5">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-border">
                    <p.icon className="size-3.5 text-accent" strokeWidth={2} />
                  </span>
                  <div>
                    <p className="text-sm font-medium tracking-tight">
                      {p.title}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {p.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <ConfirmationCard />
        </div>
      </section>

      {/* -------------------------------------------------------- closing CTA */}
      <section className="container pb-24">
        <div className="relative overflow-hidden rounded-3xl bg-accent px-8 py-16 text-accent-foreground sm:px-16 sm:py-24 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:64px_64px]"
          />
          <h2 className="relative mx-auto max-w-3xl text-display text-3xl sm:text-5xl tracking-tight leading-[1.08]">
            Tell us where you want to play. We&apos;ll build the whole trip.
          </h2>
          <div className="relative mt-10">
            <Button
              asChild
              size="lg"
              className="h-12 px-7 bg-background text-foreground hover:bg-card"
            >
              <Link href={primaryHref}>
                Plan my trip <ArrowRight className="ml-1.5 size-4" />
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

/* -------------------------------------------------------------------------- */
/* Hero itinerary card — the product, rendered with real layout primitives     */
/* -------------------------------------------------------------------------- */

function TripCard() {
  return (
    <div className="relative rounded-3xl border border-border bg-background shadow-[0_24px_80px_-24px_rgb(0_0_0/0.18)]">
      <div className="flex items-baseline justify-between px-7 pt-6 pb-5">
        <p className="text-display text-2xl tracking-tight">Pinehurst</p>
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Jul 3–7 · 4 players
        </p>
      </div>
      <div className="divide-y divide-border border-t border-border">
        {TRIP_ITEMS.map((item) => (
          <div key={item.title} className="flex items-center gap-4 px-7 py-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-sunken/50">
              <item.icon className="size-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium tracking-tight">
                {item.title}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {item.detail}
              </p>
            </div>
            {item.price ? (
              <p className="text-sm tabular-nums">{item.price}</p>
            ) : (
              <p className="flex items-center gap-1 text-xs font-semibold text-accent">
                <BadgeCheck className="size-3.5" /> Booked
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-b-3xl bg-accent px-7 py-5 text-accent-foreground">
        <p className="text-[11px] uppercase tracking-[0.2em] opacity-70">
          Trip total · estimate
        </p>
        <p className="text-display text-2xl tabular-nums tracking-tight">
          $8,200
        </p>
      </div>
    </div>
  );
}

const TRIP_ITEMS = [
  {
    icon: Plane,
    title: "American · DFW ⇄ RDU",
    detail: "Nonstop · business class",
    price: "$2,840",
  },
  {
    icon: Flag,
    title: "Pinehurst No. 2 · championship round",
    detail: "Sunday tee time, 8:50 AM",
    price: "$1,720",
  },
  {
    icon: BedDouble,
    title: "The Carolina Hotel · 4 nights",
    detail: "Suite · published rate",
    price: "$3,640",
  },
  {
    icon: UtensilsCrossed,
    title: "Drum & Quill · welcome dinner",
    detail: "Reserved · 7:30 PM",
    price: null,
  },
  {
    icon: Car,
    title: "Uber Black · all transfers",
    detail: "RDU ⇄ resort, on call",
    price: null,
  },
];

/* -------------------------------------------------------------------------- */
/* Proof card — the "Booked ✓" end-state the customer actually sees            */
/* -------------------------------------------------------------------------- */

function ConfirmationCard() {
  return (
    <div className="relative mx-auto w-full max-w-[440px]">
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[2rem] bg-foreground/[0.03] blur-2xl"
      />
      <div className="relative rounded-3xl border border-border bg-background p-7 shadow-[0_24px_80px_-24px_rgb(0_0_0/0.18)]">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
            <BadgeCheck className="size-5" strokeWidth={2} />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-tight">
              Booked — The Carolina Hotel
            </p>
            <p className="text-xs text-muted-foreground">
              Confirmed in the resort&apos;s own system
            </p>
          </div>
        </div>
        <dl className="mt-6 divide-y divide-border border-y border-border text-sm">
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Confirmation</dt>
            <dd className="font-mono text-[13px] tracking-wide text-accent">CRH-40192</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Total stay</dt>
            <dd className="tabular-nums">$3,640.00</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Under name</dt>
            <dd>4 nights · suite</dd>
          </div>
        </dl>
        <p className="mt-5 flex items-start gap-2 text-xs text-muted-foreground leading-relaxed">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          The venue emails you their own confirmation too — two independent
          records of every booking.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

const BOOKING_LOG = [
  { t: "00:02", msg: "session ready · eu-central" },
  { t: "00:05", msg: "cookie banner cleared" },
  { t: "00:11", msg: "booking engine opened" },
  { t: "00:58", msg: "dates set · Aug 11 → 20 · 2 adults" },
  { t: "01:31", msg: "12 rooms found · cheapest selected" },
  { t: "02:14", msg: "guest details filled" },
  { t: "02:49", msg: "reservation confirmed · under your name" },
];

const ASSURANCES = [
  "Real prices, never guessed",
  "Venue-direct reservations",
  "Swap anything before you book",
];

const DESTINATIONS = [
  "Pinehurst",
  "Pebble Beach",
  "St Andrews",
  "Bandon Dunes",
  "Adare Manor",
  "Portofino",
];

const STEPS = [
  {
    icon: ListChecks,
    title: "Answer the quiz",
    body: "A few quick questions — where, when, who, the vibe, the budget. No forms, no back-and-forth.",
  },
  {
    icon: Wand2,
    title: "AI builds the trip",
    body: "Flights, lodging, tee times, dining, and ground transport — a complete day-by-day itinerary with real, current prices.",
  },
  {
    icon: CalendarCheck2,
    title: "Book the big pieces",
    body: "One tap books your flights and your stay. You pick your tee times, and we line up dining and transfers — the logistics, handled.",
  },
];

const FEATURES = [
  {
    icon: ReceiptText,
    title: "Real prices, never guessed",
    body: "Live flight fares, published hotel and green-fee rates, and ride costs from actual driving distance. If we can't confirm it, we don't show it.",
  },
  {
    icon: Plane,
    title: "Fastest routes, automatically",
    body: "Flights ranked by speed and stops, not just price — the nonstop a private concierge would put you on.",
  },
  {
    icon: Sparkles,
    title: "Your stay, booked direct",
    body: "Even at independent resorts no travel site carries, our agent reserves your room on the property's own site — with a concierge to finish anything it can't.",
  },
  {
    icon: UtensilsCrossed,
    title: "Tee times & tables, lined up",
    body: "You pick your tee times so the round is yours, and the restaurants you actually want are ready to reserve in a tap — no phone tag, no guesswork.",
  },
  {
    icon: ShieldCheck,
    title: "Proof you can see",
    body: "Every booking we complete comes back with the venue's own confirmation number and page — so you know it's real, not a maybe.",
  },
  {
    icon: RefreshCcw,
    title: "Swap anything, instantly",
    body: "Don't love a pick? Tap for an alternative. The plan and the totals rebuild on the spot.",
  },
];

const PROOFS = [
  {
    icon: ReceiptText,
    title: "The venue's own confirmation number",
    body: "Not a Pyltrix reference — the code their front desk looks up.",
  },
  {
    icon: BadgeCheck,
    title: "A capture of the confirmation page",
    body: "You see exactly what we saw the moment the booking completed.",
  },
  {
    icon: ShieldCheck,
    title: "The venue emails you directly",
    body: "Their confirmation lands in your inbox alongside ours.",
  },
];

function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-lg bg-accent">
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
