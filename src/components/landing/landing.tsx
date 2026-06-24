"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  motion,
  AnimatePresence,
  useInView,
  useReducedMotion,
} from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BedDouble,
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
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/* -------------------------------------------------------------------------- */
/* Data                                                                        */
/* -------------------------------------------------------------------------- */

type TripItem = {
  icon: LucideIcon;
  title: string;
  detail: string;
  price: string;
};
type Trip = {
  name: string;
  region: string;
  when: string;
  total: number;
  items: TripItem[];
};

// Showcase trips are built around hotels in LiteAPI's strong leisure-luxury
// European golf markets — the properties we can book via the API in seconds,
// NOT the US resort-direct ones the agent struggles with. Verify the exact
// hotels with `pnpm check:landing-hotels` before trusting this list.
const TRIPS: Trip[] = [
  {
    name: "Scottsdale",
    region: "Arizona",
    when: "Mar 12–16 · 4 players",
    total: 4600,
    items: [
      { icon: Plane, title: "American · DFW ⇄ PHX", detail: "Nonstop · first class", price: "$840" },
      { icon: Flag, title: "TPC Scottsdale · Stadium", detail: "Saturday · 8:40 AM", price: "$680" },
      { icon: BedDouble, title: "Fairmont Princess · 4 nights", detail: "Resort-view suite", price: "$2,720" },
      { icon: UtensilsCrossed, title: "Mowry & Cotton", detail: "Steakhouse · 7:30 PM", price: "$360" },
    ],
  },
  {
    name: "Algarve",
    region: "Quinta do Lago · Portugal",
    when: "Oct 4–8 · 4 players",
    total: 7660,
    items: [
      { icon: Plane, title: "TAP Air · EWR ⇄ FAO", detail: "Business class", price: "$3,360" },
      { icon: Flag, title: "Quinta do Lago · South", detail: "Saturday · 9:40 AM", price: "$540" },
      { icon: BedDouble, title: "Conrad Algarve · 4 nights", detail: "Deluxe pool suite", price: "$3,280" },
      { icon: UtensilsCrossed, title: "Gusto by Heinz Beck", detail: "Michelin · 8:00 PM", price: "$480" },
    ],
  },
  {
    name: "Palm Springs",
    region: "Palm Desert · California",
    when: "Jan 22–26 · 4 players",
    total: 4540,
    items: [
      { icon: Plane, title: "United · ORD ⇄ PSP", detail: "Nonstop · first class", price: "$1,180" },
      { icon: Flag, title: "PGA West · Stadium", detail: "Saturday · 9:10 AM", price: "$580" },
      { icon: BedDouble, title: "JW Marriott · 4 nights", detail: "Desert Springs · suite", price: "$2,360" },
      { icon: UtensilsCrossed, title: "Cuistot · Palm Desert", detail: "Fine dining · 7:30 PM", price: "$420" },
    ],
  },
  {
    name: "Marbella",
    region: "Costa del Sol · Spain",
    when: "May 18–22 · 4 players",
    total: 7840,
    items: [
      { icon: Plane, title: "Iberia · JFK ⇄ AGP", detail: "Business class", price: "$3,180" },
      { icon: Flag, title: "Real Club Valderrama", detail: "Saturday · 10:20 AM", price: "$620" },
      { icon: BedDouble, title: "Puente Romano · 4 nights", detail: "Beachside suite", price: "$3,520" },
      { icon: UtensilsCrossed, title: "Dani García · Marbella", detail: "3-Michelin · 8:30 PM", price: "$520" },
    ],
  },
];

const ASSURANCES = [
  "Real prices, never guessed",
  "Swap anything before you book",
  "Built in minutes, not weeks",
];

const BUILD_LOG = [
  "reading your answers · Scotland · 2 players · June",
  "searching 240 flights · JFK → Edinburgh",
  "matched The Old Course · Tue 11:40 AM",
  "Old Course Hotel · course-view · 5 nights",
  "dinner held · The Seafood Ristorante",
  "private transfers routed · airport ⇄ town",
  "trip ready · $9,400 estimate",
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
    body: "Flights, lodging, tee times, dining, and transfers — a complete day-by-day itinerary at real, current prices.",
  },
  {
    icon: BadgeCheck,
    title: "Book the big pieces",
    body: "One tap books your flights and your stay. You pick your tee times, and we line up dining and transfers.",
  },
];

const FEATURES = [
  {
    icon: ReceiptText,
    title: "Real prices, never guessed",
    body: "Live flight fares, published hotel and green-fee rates, ride costs from real driving distance. If we can't confirm it, we don't show it.",
  },
  {
    icon: Plane,
    title: "The fastest routes, automatically",
    body: "Flights ranked by speed and stops, not just price — the nonstop you'd actually choose.",
  },
  {
    icon: Sparkles,
    title: "Your stay, booked direct",
    body: "Even at independent resorts no travel site carries, our agent reserves your room on the property's own site — and we finish anything it can't.",
  },
  {
    icon: UtensilsCrossed,
    title: "Tee times & tables, lined up",
    body: "You pick your tee times so the round is yours, and the restaurants you actually want are ready to reserve in a tap.",
  },
  {
    icon: ShieldCheck,
    title: "Proof you can see",
    body: "Every booking we complete comes back with the venue's own confirmation number and page — so you know it's real.",
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

const DESTINATIONS = [
  "Scottsdale",
  "Palm Springs",
  "Algarve",
  "Marbella",
  "Sotogrande",
  "Naples",
];

const EASE = [0.16, 1, 0.3, 1] as const;

/* -------------------------------------------------------------------------- */
/* Scroll-reveal helper                                                        */
/* -------------------------------------------------------------------------- */

function Reveal({
  children,
  className,
  delay = 0,
  y = 22,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero — interactive destination switcher + live-building trip card           */
/* -------------------------------------------------------------------------- */

function Hero({ primaryHref }: { primaryHref: string }) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const trip = TRIPS[active];

  // Auto-advance the showcase until the visitor takes over.
  useEffect(() => {
    if (paused || reduce) return;
    const t = setInterval(() => setActive((a) => (a + 1) % TRIPS.length), 3600);
    return () => clearInterval(t);
  }, [paused, reduce]);

  return (
    <section className="relative overflow-hidden">
      {/* Drifting fairway-green orbs + hairline grid so the hero breathes. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute -top-32 right-[-10%] size-[42rem] rounded-full bg-accent/[0.07] blur-3xl"
          animate={reduce ? undefined : { x: [0, -40, 0], y: [0, 30, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-[-20%] left-[-12%] size-[34rem] rounded-full bg-accent/[0.05] blur-3xl"
          animate={reduce ? undefined : { x: [0, 50, 0], y: [0, -24, 0] }}
          transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px)] [background-size:120px_100%]" />
      </div>

      <div className="container relative grid items-center gap-14 pt-14 pb-20 sm:pt-20 sm:pb-28 lg:grid-cols-[1.05fr_0.95fr]">
        {/* ---- copy ---- */}
        <div>
          <motion.p
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-[11px] uppercase tracking-[0.28em] text-accent"
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/40" />
              <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
            </span>
            Launching soon · invite-only
          </motion.p>

          <motion.h1
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.08 }}
            className="mt-7 text-display text-4xl leading-[1.05] tracking-[-0.03em] sm:text-6xl sm:leading-[1.03] sm:tracking-[-0.035em] lg:text-[4.4rem]"
          >
            Your dream golf trip, planned to the last detail —
            <em className="text-accent font-light"> in minutes.</em>
          </motion.h1>

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.16 }}
            className="mt-6 max-w-xl text-base sm:text-lg text-muted-foreground leading-relaxed"
          >
            Answer a few questions and Pyltrix&apos;s AI designs your complete
            luxury golf trip — flights, five-star stays, tee times, dining, and
            transfers — at real, current prices. We book your flights and your
            stay, you pick your tee times, and we line up the rest.
          </motion.p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.24 }}
            className="mt-9 flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3"
          >
            <Button asChild size="lg" className="group h-12 px-7">
              <Link href={primaryHref}>
                Plan my trip
                <ArrowRight className="ml-1.5 size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="h-12 px-6">
              <Link href="#how">See how it works</Link>
            </Button>
          </motion.div>

          <motion.ul
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.36 }}
            className="mt-10 flex flex-wrap gap-x-7 gap-y-3 text-[13px] text-muted-foreground"
          >
            {ASSURANCES.map((a) => (
              <li key={a} className="flex items-center gap-2">
                <CheckCheck className="size-3.5 text-accent" />
                {a}
              </li>
            ))}
          </motion.ul>
        </div>

        {/* ---- interactive product ---- */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.2 }}
          className="relative mx-auto w-full max-w-[480px] lg:max-w-none"
          onMouseEnter={() => setPaused(true)}
        >
          {/* tap-a-course switcher — wrap on mobile so no pill is hidden off
              the edge (the hidden-scrollbar row read as "cut off" on a phone). */}
          <div className="mb-4 flex flex-wrap gap-2 sm:flex-nowrap sm:overflow-x-auto sm:no-scrollbar pb-1">
            {TRIPS.map((t, i) => {
              const on = i === active;
              return (
                <button
                  key={t.name}
                  onClick={() => {
                    setActive(i);
                    setPaused(true);
                  }}
                  aria-pressed={on}
                  className={`relative shrink-0 rounded-full px-4 py-2 text-[13px] font-medium tracking-tight transition-colors ${
                    on
                      ? "text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {on && (
                    <motion.span
                      layoutId="dest-pill"
                      className="absolute inset-0 rounded-full bg-accent"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{t.name}</span>
                </button>
              );
            })}
          </div>

          <div
            aria-hidden
            className="absolute -inset-6 -z-10 rounded-[2rem] bg-accent/[0.06] blur-2xl"
          />
          <motion.div
            animate={reduce ? undefined : { y: [0, -7, 0] }}
            transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          >
            <TripCard trip={trip} reduce={!!reduce} primaryHref={primaryHref} />
          </motion.div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            A complete trip Pyltrix planned in one pass — real flights, real
            rates, ready to book.
          </p>
        </motion.div>
      </div>
    </section>
  );
}

// Counts a number up to its target with an ease-out, so the trip total ticks
// when you switch courses instead of just popping in.
function useCountUp(target: number, reduce: boolean): number {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    if (reduce) {
      setVal(target);
      prev.current = target;
      return;
    }
    const from = prev.current;
    prev.current = target;
    const start = performance.now();
    const dur = 650;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce]);
  return val;
}

// Faint topographic contour lines behind the card header — a course-map /
// elevation feel, fully abstract so it needs no photography and stays on-brand.
function ContourLines() {
  const rows = [12, 28, 44, 60, 76, 92];
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full text-accent/[0.09]"
      preserveAspectRatio="none"
      viewBox="0 0 400 104"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      {rows.map((y, i) => (
        <path
          key={y}
          d={`M-20 ${y} C 70 ${y - 10 - i * 1.5} 150 ${y + 12} 220 ${y - 5} S 360 ${y + 11} 420 ${y - 3}`}
        />
      ))}
    </svg>
  );
}

function TripCard({
  trip,
  reduce,
  primaryHref,
}: {
  trip: Trip;
  reduce: boolean;
  primaryHref: string;
}) {
  const total = useCountUp(trip.total, reduce);
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-card shadow-[0_28px_90px_-28px_rgb(0_0_0/0.22)]">
      {/* header — contour texture + destination */}
      <div className="relative overflow-hidden border-b border-border bg-surface-sunken/40 px-6 pt-6 pb-5 sm:px-7">
        <ContourLines />
        <AnimatePresence mode="wait">
          <motion.div
            key={trip.name}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="relative flex items-start justify-between gap-3"
          >
            <div>
              <p className="text-display text-[1.7rem] leading-none tracking-tight">
                {trip.name}
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="size-3 text-accent" />
                {trip.region}
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {trip.when}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* items */}
      <AnimatePresence mode="wait">
        <motion.div
          key={trip.name}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="divide-y divide-border"
        >
          {trip.items.map((item, i) => (
            <motion.div
              key={item.title}
              initial={reduce ? false : { opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: 0.04 + i * 0.07 }}
              className="group flex items-center gap-3.5 px-6 py-3.5 transition-colors hover:bg-surface-sunken/40 sm:px-7"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent transition-transform group-hover:scale-105">
                <item.icon className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium tracking-tight">{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
              </div>
              <p className="num-tabular text-sm font-medium">{item.price}</p>
            </motion.div>
          ))}
        </motion.div>
      </AnimatePresence>

      {/* total */}
      <Link
        href={primaryHref}
        className="group flex items-center justify-between gap-3 bg-accent px-6 py-4 text-accent-foreground transition-colors hover:bg-accent/90 sm:px-7"
      >
        <span className="text-[11px] uppercase tracking-[0.18em] opacity-75">
          Trip total · estimate
        </span>
        <span className="flex items-center gap-2.5">
          <span className="text-display num-tabular text-2xl tracking-tight">
            ${total.toLocaleString("en-US")}
          </span>
          <ArrowRight className="size-4 opacity-80 transition-transform group-hover:translate-x-1" />
        </span>
      </Link>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* "Watch it build" — log that types itself in once scrolled into view         */
/* -------------------------------------------------------------------------- */

function BuildDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-120px" });
  const reduce = useReducedMotion();
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setN(BUILD_LOG.length);
      return;
    }
    if (n >= BUILD_LOG.length) return;
    const t = setTimeout(() => setN((x) => x + 1), 460);
    return () => clearTimeout(t);
  }, [inView, n, reduce]);

  const done = n >= BUILD_LOG.length;

  return (
    <div
      ref={ref}
      className="rounded-2xl border border-[#2a2e28] bg-[#0c0f0b] shadow-[0_40px_90px_-44px_rgb(0_0_0/0.7)] overflow-hidden"
    >
      <div className="flex items-center gap-2 border-b border-[#2a2e28] px-4 py-3 font-mono text-[11px] text-[#7f8378]">
        <span className="flex gap-1.5 mr-2">
          <i className="block size-2 rounded-full bg-[#2e332c]" />
          <i className="block size-2 rounded-full bg-[#2e332c]" />
          <i className="block size-2 rounded-full bg-[#2e332c]" />
        </span>
        pyltrix · building your trip
        {!done && (
          <span className="ml-auto flex items-center gap-1.5 text-[#69b489]">
            <span className="size-1.5 animate-pulse rounded-full bg-[#69b489]" />
            working
          </span>
        )}
      </div>
      <div className="px-5 py-5 font-mono text-[12.5px] leading-[2.1] min-h-[260px]">
        {BUILD_LOG.slice(0, n).map((msg, i) => {
          const last = i === BUILD_LOG.length - 1;
          return (
            <motion.div
              key={msg}
              initial={reduce ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3 }}
              className="flex gap-3.5"
            >
              <span className="w-9 shrink-0 text-[#5d6157]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="shrink-0 text-[#69b489]">{last ? "★" : "✓"}</span>
              <span
                className={
                  "min-w-0 break-words " +
                  (last ? "font-medium text-[#f2f1ea]" : "text-[#c9ccc0]")
                }
              >
                {msg}
              </span>
            </motion.div>
          );
        })}
        {!done && inView && (
          <span className="ml-[3.4rem] inline-block h-[1.05em] w-[0.6ch] translate-y-0.5 animate-pulse bg-[#69b489]" />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export function Landing({
  userId,
  primaryHref,
}: {
  userId: string | null;
  primaryHref: string;
}) {
  return (
    <main className="relative min-h-dvh bg-background text-foreground">
      {/* ------------------------------------------------------------- nav */}
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
                <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
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

      <Hero primaryHref={primaryHref} />

      {/* ----------------------------------------------- destinations marquee */}
      <section className="border-y border-border bg-surface-sunken/40">
        <div className="container flex flex-wrap items-center justify-center gap-x-9 gap-y-3 py-6 text-[13px] uppercase tracking-[0.22em] text-muted-foreground">
          {DESTINATIONS.map((d) => (
            <span key={d} className="flex items-center gap-2">
              <MapPin className="size-3.5 opacity-50" />
              {d}
            </span>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------- watch it build */}
      <section className="bg-[#121511] text-[#f2f1ea]">
        <div className="container grid items-center gap-14 py-20 sm:py-28 lg:grid-cols-2">
          <Reveal>
            <p className="text-[11px] uppercase tracking-[0.3em] text-[#7f8378]">
              Behind the magic
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight leading-[1.06]">
              Watch your whole trip
              <br className="hidden sm:block" /> come together.
            </h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-[#b5b8ae]">
              You answer a few questions. In one pass, Pyltrix searches live
              flights, picks the right stay, lines up tee times and tables, and
              routes every transfer — then hands you a complete trip at real
              prices, ready to book.
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <BuildDemo />
          </Reveal>
        </div>
      </section>

      {/* ----------------------------------------------------- how it works */}
      <section id="how" className="container scroll-mt-24 py-20 sm:py-28">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
            How it works
          </p>
          <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight">
            Three steps. Zero spreadsheets.
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-px sm:grid-cols-3 bg-border border border-border rounded-2xl overflow-hidden">
          {STEPS.map((step, i) => (
            <Reveal key={step.title} delay={i * 0.08} className="bg-background">
              <div className="h-full p-8 sm:p-10">
                <div className="flex items-center justify-between">
                  <span className="grid size-11 place-items-center rounded-xl border border-border bg-surface-sunken/50">
                    <step.icon className="size-5 text-accent" strokeWidth={1.75} />
                  </span>
                  <p className="text-display text-2xl text-accent/50 tabular-nums">
                    0{i + 1}
                  </p>
                </div>
                <h3 className="mt-7 text-lg font-medium tracking-tight">{step.title}</h3>
                <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">
                  {step.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------- feature grid */}
      <section className="border-t border-border bg-surface-sunken/40">
        <div className="container py-20 sm:py-28">
          <Reveal className="max-w-2xl">
            <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              What you get
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight">
              A real trip, not a list of links.
            </h2>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border rounded-2xl overflow-hidden">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={(i % 3) * 0.06} className="bg-background">
                <motion.div
                  whileHover={{ y: -4 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  className="group h-full p-8"
                >
                  <div className="flex items-start justify-between">
                    <span className="grid size-10 place-items-center rounded-lg border border-border bg-surface-sunken/50">
                      <f.icon className="size-[18px] text-accent" strokeWidth={1.75} />
                    </span>
                    <ArrowUpRight className="size-4 text-muted-foreground/30 transition group-hover:text-foreground group-hover:rotate-12" />
                  </div>
                  <h3 className="mt-6 text-base font-medium tracking-tight">{f.title}</h3>
                  <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">
                    {f.body}
                  </p>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ proof section */}
      <section className="container py-20 sm:py-28">
        <div className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal>
            <p className="text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              Booked means booked
            </p>
            <h2 className="mt-4 text-display text-3xl sm:text-5xl tracking-tight leading-[1.08]">
              Every reservation comes with receipts.
            </h2>
            <p className="mt-6 max-w-lg text-base text-muted-foreground leading-relaxed">
              When Pyltrix books a venue, you get the venue&apos;s own
              confirmation — number, amount, and a capture of their confirmation
              page. The reservation sits in{" "}
              <em className="not-italic font-medium text-foreground">their</em>{" "}
              system under your name, so the front desk already knows
              you&apos;re coming.
            </p>
            <ul className="mt-8 space-y-4">
              {PROOFS.map((p, i) => (
                <Reveal key={p.title} delay={0.08 + i * 0.06}>
                  <li className="flex gap-3.5">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-border">
                      <p.icon className="size-3.5 text-accent" strokeWidth={2} />
                    </span>
                    <div>
                      <p className="text-sm font-medium tracking-tight">{p.title}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">{p.body}</p>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1}>
            <ConfirmationCard />
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------- closing CTA */}
      <section className="container pb-24">
        <Reveal>
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
                className="group h-12 px-7 bg-background text-foreground hover:bg-card"
              >
                <Link href={primaryHref}>
                  Plan my trip
                  <ArrowRight className="ml-1.5 size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
            </div>
          </div>
        </Reveal>
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
/* Proof card                                                                  */
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
              Booked — Old Course Hotel
            </p>
            <p className="text-xs text-muted-foreground">
              Confirmed in the resort&apos;s own system
            </p>
          </div>
        </div>
        <dl className="mt-6 divide-y divide-border border-y border-border text-sm">
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Confirmation</dt>
            <dd className="font-mono text-[13px] tracking-wide text-accent">OCH-40192</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Total stay</dt>
            <dd className="num-tabular">$3,300.00</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-muted-foreground">Under name</dt>
            <dd>5 nights · course-view</dd>
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
