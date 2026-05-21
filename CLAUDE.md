# CLAUDE.md — context for Claude Code sessions

> This file is auto-loaded at the start of every Claude Code session in this
> repo. Keep it tight; it costs tokens on every turn. Update it as the
> product evolves so future sessions inherit the latest mental model.

## Product

**Pyltrix** — AI-driven luxury golf travel booking platform (OTA).

One conversational interface plans + books complete golf trips: flights,
hotels, tee times, ground transport, dining, travel insurance. The chat is
the primary surface; a "Live Trip" side panel fills in as the AI commits
details. The founder is **Carson Nix** (nixcarson6@gmail.com, solo founder,
pre-launch).

## Stack

- **Next.js 15** (App Router) + **TypeScript** + Tailwind + shadcn-style UI
- **Auth**: Clerk (`@clerk/nextjs` v6) — supports keyless dev mode
- **DB**: Neon Postgres + Prisma (NOT Supabase — we tried, picked Neon for
  branching). Schema in `prisma/schema.prisma`
- **AI**: Anthropic Claude — `claude-opus-4-7` for orchestration,
  `claude-haiku-4-5-20251001` for fast scoring. Hand-rolled orchestrator
  in `src/lib/ai/`
- **Payments**: Stripe (not yet integrated end-to-end)
- **Maps**: Google Maps Platform
- **Web search**: Tavily (primary) + Anthropic-hosted web_search (fallback)
- **Booking partners**: Duffel (flights), Hotelbeds (hotels), Lightspeed
  Golf / GolfNow (tee times), CarTrawler (rental cars — covers Avis/Hertz
  so we don't need them separately), OpenTable + Yelp Fusion (restaurants),
  Trawick (travel insurance), Uber for Business via Central (ground)

## Layout

```
src/
├── app/                  # Next.js routes (pages + API)
│   ├── api/trips/[tripId]/messages/stream/  # SSE chat endpoint
│   └── trips/[tripId]/   # Workspace pages
├── components/concierge/ # Chat UI, live preview, chat cards
├── lib/
│   ├── ai/               # Orchestrator, streamReply, agents, prompts
│   │   ├── streamReply.ts       # The main streaming generator
│   │   ├── chat-cards.ts        # Tool-result -> ChatCard parsers
│   │   └── agents/              # Per-domain agents (destination, itinerary, etc.)
│   ├── bookings/providers/      # One file per booking partner
│   └── env.ts            # Central env access with required/optional flags
└── prisma/schema.prisma  # Full data model
```

## Dev workflow (Windows / PowerShell)

```powershell
git pull origin claude/google-maps-chat-data-XqLnu   # main working branch
pnpm install
pnpm db:push        # syncs Prisma schema to Neon (uses dotenv-cli to read .env.local)
pnpm check:env      # verifies env vars + DB connection — RUN THIS FIRST when debugging
pnpm dev            # localhost:3000
pnpm typecheck      # tsc --noEmit
```

`pnpm db:push`, `db:migrate`, `db:studio`, `db:seed` all go through
`dotenv-cli` (`dotenv -e .env.local -- prisma ...`) because Prisma CLI
otherwise only reads `.env`, not `.env.local`.

## API key status (live)

✅ = working in `.env.local`. ⏳ = applied/waiting. ❌ = not yet applied.

| Provider | Status | Notes |
|---|---|---|
| Anthropic | ✅ | Required for AI chat to respond |
| Neon (DB) | ✅ | `DATABASE_URL` = pooled, `DIRECT_URL` = direct (no `-pooler`) |
| Clerk | ✅ | Real test keys; keyless mode also works with NO keys |
| Duffel | ✅ | Test mode key, flights work |
| Tavily | ✅ | Web search tool wired into orchestrator |
| Google Maps | ✅ | Trip map + place lookup |
| Yelp Fusion | ✅ | Restaurant data (search/details), can't book directly |
| Stripe | ❌ | Required for any payment flow |
| Resend | ❌ | Required for invite/confirmation emails |
| Hotelbeds | ⏳ emailed | Primary hotel inventory |
| OpenTable | ⏳ emailed | Real restaurant reservations |
| GolfNow | ❌ | The big US tee-time inventory — apply ASAP |
| Lightspeed Golf (Chronogolf) | ⏳ filled out intake form | Independent course tee times |
| CarTrawler | ⏳ applied | Aggregates Avis/Hertz/Enterprise/Budget |
| Trawick | 📝 filling out forms | Travel insurance — selected OTA, Travel Accident/Travel Agency/Limited Lines license |
| Uber for Business | ⏳ account created, requested Central API access | Programmatic guest rides |

## Working branch

**`claude/google-maps-chat-data-XqLnu`** — all current work lives here. Main
hasn't been merged in a while.

## Recent decisions / context

- **Notepad is banned for env editing.** It mangles encoding/quotes and has
  caused multiple hours of debugging. Use VS Code. There's a `pnpm check:env`
  script (`scripts/check-env.ts`) that runs a live SELECT 1 against the DB
  and prints ✅/⚪/❌ for every env var — always run this before assuming
  env is good.
- **CarTrawler obsoletes Avis/Hertz** as separate integrations.
- **Clerk keyless dev mode** is used when no Clerk keys are present. The
  auth helper in `src/lib/auth.ts` rebinds Users by email when Clerk IDs
  change between sessions (necessary because keyless mints new IDs each time).
- **Chat improvements landed**: inline `FlightCard`/`HotelCard`/`TeeTimeCard`
  inside assistant bubbles, streaming tool indicators ("Searching flights
  DFW → COS…" pills), smooth streaming (no markdown reparse per token),
  clickable follow-ups. See `src/components/concierge/chat-cards.tsx` and
  `src/lib/ai/chat-cards.ts`.
- **AI tools live now**: `search_flights`, `book_flight`, `search_hotels`,
  `book_hotel`, `book_tee_time`, `book_restaurant`, `book_car`,
  `tavily_search`, `web_search`. When a provider key is missing the tool
  returns an honest error; the AI surfaces "not wired up yet" rather than
  faking confirmations.

## Working with the user

- Carson is **non-technical / first-time engineer**. Explain commands and
  what they do; don't assume git/PowerShell fluency.
- Default OS is **Windows / PowerShell**, not bash. Translate Unix idioms.
- Be empathetic when env/setup debugging drags on — these problems compound.
- **Never paste real API keys or passwords in chat replies.** If the user
  exposes one, mention rotation once briefly, then move on.
- Carson sometimes copies commands from chat into PowerShell — that wipes
  the clipboard. When designing flows that need clipboard data, account
  for this (e.g. write to a script file first).

## Next-up priorities (when picked back up)

1. **Stripe + Resend** signups — both instant, both unblock big chunks of
   the flow
2. **GolfNow application** — longest queue still un-filed; core to the product
3. **Live Trip canvas** — make the right-side panel actually evolve as the
   AI extracts constraints / commits bookings (deferred from chat polish work)
4. **Restaurant photos via Google Places** — small addition, makes the
   product feel more visual
