import Link from "next/link";
import { ArrowRight, Sparkles, Compass, Users, CreditCard, MapPin, Wand2 } from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default async function LandingPage() {
  const { userId } = await auth();
  const primaryHref = userId ? "/dashboard" : "/sign-up";

  return (
    <main className="relative min-h-dvh">
      <div className="pointer-events-none absolute inset-0 bg-concierge-radial" aria-hidden />

      <header className="relative z-10">
        <nav className="container flex items-center justify-between py-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-display text-lg">Golf Concierge</span>
          </Link>
          <div className="flex items-center gap-2">
            {userId ? (
              <Button asChild variant="navy" size="sm">
                <Link href="/dashboard">
                  Dashboard <ArrowRight className="ml-1" />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/sign-in">Sign in</Link>
                </Button>
                <Button asChild variant="navy" size="sm">
                  <Link href="/sign-up">Get started</Link>
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>

      <section className="container relative z-10 pt-16 pb-24 sm:pt-24">
        <Badge variant="navy" className="mb-6">
          <Sparkles className="size-3" /> AI concierge · invite-only beta
        </Badge>
        <h1 className="text-display text-5xl sm:text-7xl leading-[1.02] tracking-[-0.025em] max-w-4xl">
          The trip you'd ask a private concierge to plan.<br />
          <span className="text-muted-foreground">Now in plain English.</span>
        </h1>
        <p className="mt-7 max-w-2xl text-lg text-muted-foreground leading-relaxed">
          Describe the golf trip you want. A team of agents handles
          destinations, courses, lodging, flights, dining, group payments,
          and bookings — and quietly re-plans the moment anything changes.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button asChild variant="navy" size="lg">
            <Link href={primaryHref}>
              Start a trip <ArrowRight />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="#how">See how it works</Link>
          </Button>
        </div>

        <div className="mt-16 grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl">
          {STATS.map((s) => (
            <div key={s.label} className="glass rounded-2xl p-5">
              <p className="text-display text-2xl num-tabular">{s.value}</p>
              <p className="mt-1 text-xs text-muted-foreground uppercase tracking-wide">
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="container relative z-10 pb-24">
        <div className="mb-10 max-w-2xl">
          <h2 className="text-display text-3xl sm:text-4xl tracking-tight">
            Hands-free, end-to-end.
          </h2>
          <p className="mt-3 text-muted-foreground">
            No forms. No tabs. No spreadsheet payment trackers. Just a
            conversation and a live itinerary that updates beside it.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="glass rounded-2xl p-6">
              <div className="size-10 rounded-xl border border-[hsl(var(--navy)/0.3)] bg-[hsl(var(--navy)/0.08)] flex items-center justify-center text-[hsl(var(--navy))]">
                {f.icon}
              </div>
              <h3 className="mt-5 text-base font-medium">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer className="container relative z-10 pb-10 text-sm text-muted-foreground flex items-center justify-between">
        <span>© {new Date().getFullYear()} Golf Concierge</span>
        <Link href={primaryHref} className="hover:text-foreground transition">
          Plan a trip →
        </Link>
      </footer>
    </main>
  );
}

const STATS = [
  { value: "5+", label: "Premium markets" },
  { value: "9", label: "Specialist AI agents" },
  { value: "End→end", label: "Booked & paid" },
  { value: "0", label: "Spreadsheets" },
];

const FEATURES = [
  {
    icon: <Wand2 className="size-5" />,
    title: "Conversational planning",
    body: "Describe the trip you want. The concierge asks only what it needs and refines as you go.",
  },
  {
    icon: <Compass className="size-5" />,
    title: "Destination intelligence",
    body: "Course quality, weather, logistics, nightlife — scored honestly for your group, not flattened to 90s.",
  },
  {
    icon: <MapPin className="size-5" />,
    title: "Live itinerary",
    body: "A day-by-day plan rebuilds in real time as you refine. See every cost, every rationale.",
  },
  {
    icon: <Users className="size-5" />,
    title: "Group, handled",
    body: "Invites, approvals, preferences, split payments — coordinated without a single group chat.",
  },
  {
    icon: <CreditCard className="size-5" />,
    title: "Stripe-native checkout",
    body: "Per-person links, deposit or full balance, real-time payment tracking. PCI scope handled.",
  },
  {
    icon: <Sparkles className="size-5" />,
    title: "Re-optimization, quietly",
    body: "Tee time taken? Weather turned? Plans rebuild without a single email thread.",
  },
];

function Logo() {
  return (
    <span className="size-8 rounded-xl bg-gradient-to-br from-[hsl(var(--navy))] to-[hsl(var(--navy-muted))] grid place-items-center">
      <svg viewBox="0 0 24 24" className="size-4 text-[hsl(var(--primary-foreground))]" fill="currentColor">
        <path d="M12 2c1.5 4 4 6.5 8 8-4 1.5-6.5 4-8 8-1.5-4-4-6.5-8-8 4-1.5 6.5-4 8-8Z" />
      </svg>
    </span>
  );
}
