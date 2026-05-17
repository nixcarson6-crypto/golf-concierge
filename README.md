# Golf Concierge

AI-native luxury golf travel platform. Chat-first "Concierge Command Center" where a system of specialised agents plans, optimises, and books premium group golf trips end-to-end.

## Stack

- **Framework**: Next.js 15 (App Router) + TypeScript + Tailwind + shadcn-style UI primitives
- **Auth**: Clerk
- **Database**: Supabase Postgres + Prisma
- **AI**: Claude Opus 4.7 (orchestration) + Haiku 4.5 (fast scoring) via Anthropic SDK with typed tool-call structured outputs
- **Multi-agent orchestration**: hand-rolled TypeScript orchestrator (`src/lib/ai/orchestrator.ts`)
- **Payments**: Stripe Checkout + webhooks
- **Background jobs**: Inngest (with synchronous fallback for demos)
- **Maps**: Google Maps Platform (`@vis.gl/react-google-maps`)
- **Email**: Resend
- **State**: TanStack Query (server state), small client state in components

## Getting started

```bash
pnpm install
cp .env.example .env.local   # fill in keys you have
pnpm db:push                 # push Prisma schema to your Supabase database
pnpm dev
```

The app boots in dark, premium mode at <http://localhost:3000>.

### Required env

At minimum: `DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`. Stripe / Google Maps / Resend / Inngest / partner-booking keys are optional — the app degrades gracefully and surfaces the gap honestly.

## Architecture

```
src/
├── app/                       # Next.js App Router (pages + API routes)
│   ├── (marketing)            # Landing
│   ├── dashboard              # User trip list
│   ├── trips/[tripId]/        # Concierge command center
│   │   ├── page.tsx           #   3-panel workspace (chat / live preview / status)
│   │   ├── destination/       #   AI destination recommendations
│   │   ├── itinerary/         #   Day-by-day, approve & book
│   │   ├── map/               #   Geographic view
│   │   ├── group/             #   Members, invites, approvals
│   │   ├── payments/          #   Stripe split payments
│   │   └── summary/           #   Generated trip summary
│   ├── invite/[token]/        # Accept group invite
│   ├── checkout/{success,cancel}
│   └── api/                   # Route handlers
│       ├── trips/[id]/...     #   Workspace, chat, itinerary, payments
│       ├── webhooks/{stripe,clerk}
│       └── inngest            #   Background-job runner
├── components/
│   ├── concierge/             # Chat, live preview, status rail, command center
│   ├── itinerary/             # Itinerary cards
│   ├── map/                   # Google Maps + a11y fallback
│   └── ui/                    # shadcn-style primitives
├── lib/
│   ├── ai/
│   │   ├── client.ts          # Anthropic SDK wrapper
│   │   ├── orchestrator.ts    # runStructured/runText + persisted AgentRun
│   │   ├── prompts.ts         # Concierge voice + per-agent system prompts
│   │   ├── schemas.ts         # Zod schemas = AI structured-output contracts
│   │   ├── conversation.ts    # Chat → constraint update → downstream agents
│   │   └── agents/
│   │       ├── constraintExtractor.ts
│   │       ├── destination.ts
│   │       ├── itinerary.ts
│   │       ├── fallback.ts    # Re-optimization on booking failure
│   │       └── summary.ts
│   ├── bookings/
│   │   ├── types.ts           # BookingPartner interface
│   │   ├── registry.ts        # Item type → partner
│   │   ├── executor.ts        # Approve → book in parallel → re-optimize on failure
│   │   └── providers/         # GolfNow, Expedia, Duffel, OpenTable… (stub today)
│   ├── jobs/                  # Inngest functions
│   ├── auth.ts                # Clerk + trip-access helpers
│   ├── db.ts                  # Prisma singleton
│   ├── stripe.ts, email.ts, env.ts
│   └── utils.ts
├── middleware.ts              # Clerk route protection
└── prisma/schema.prisma       # Full data model
```

## Booking partners

`src/lib/bookings/registry.ts` maps each itinerary-item type (tee time, lodging, flight, transport, dining) to a `BookingPartner`. Today every category is wired to a stub that produces fake confirmations so the full flow is demoable end-to-end. Real integrations (GolfNow, Expedia Rapid, Duffel, OpenTable, Uber for Business) drop in as a single file each implementing the same interface — no other code changes needed.

## Key flows

1. **Plan**: User describes the trip in chat → constraint extractor updates the Trip row → destination agent proposes options (or itinerary agent drafts if destination is known).
2. **Refine**: Further chat messages with words like "swap", "cheaper", "earlier" trigger the itinerary agent in refine mode → new immutable Itinerary version with `changes`.
3. **Approve**: Owner approves → booking executor runs all partners in parallel → confirmations stored.
4. **Re-optimize**: Any partner failure → fallback agent produces a new itinerary version → executor re-runs.
5. **Pay**: Owner creates per-member Stripe checkout sessions → webhook updates `Payment` + `TripMember.paymentStatus`.
6. **Summarise**: Summary agent compiles final itinerary + bookings + payments into a shareable trip summary.

## Scripts

```
pnpm dev          # Next.js dev
pnpm build        # Prisma generate + Next build
pnpm typecheck    # tsc --noEmit
pnpm db:push      # Push schema (no migration)
pnpm db:migrate   # Create + apply migration
pnpm db:studio    # Prisma Studio
```
