# CLAUDE.md — context for Claude Code sessions

> This file is auto-loaded at the start of every Claude Code session in this
> repo. Keep it tight; it costs tokens on every turn. Update it as the
> product evolves so future sessions inherit the latest mental model.

## Product

**Pyltrix** — AI-driven luxury golf travel booking platform (OTA).

Customers answer a structured **Hungry Root-style quiz** (15 questions across
3 sections) and the AI generates a complete bookable trip in one pass:
flights, lodging, courses, dining, ground transport. A **result page** then
lets them swap items, see venue photos, and click **"Book all"** to commit
everything. The founder is **Carson Nix** (nixcarson6@gmail.com, solo
founder, pre-launch).

**Major UX pivot (recent):** The original chat-based intake has been
**removed**. Chat workspace still exists in code (`workspace.tsx` still
imports `ConciergeChat`) but is no longer rendered — the LivePreview is the
full result page. Don't re-introduce chat without checking; Carson
deliberately killed it ("people think we're a ChatGPT wrapper, plus API
costs were 10x").

## Stack

- **Next.js 15** (App Router) + **TypeScript** + Tailwind + shadcn-style UI
- **Auth**: Clerk (`@clerk/nextjs` v6) — supports keyless dev mode
- **DB**: Neon Postgres + Prisma (NOT Supabase — we tried, picked Neon for
  branching). Schema in `prisma/schema.prisma`
- **AI**: Anthropic Claude — `claude-opus-4-7` for orchestration,
  `claude-haiku-4-5-20251001` for fast scoring + per-card swap suggestions.
  Hand-rolled orchestrator in `src/lib/ai/`
- **Payments**: Stripe (not yet integrated end-to-end)
- **Maps**: Google Maps Platform (Places API New — venue photos in the
  itinerary item dialog)
- **Web search**: Tavily (primary) + Anthropic-hosted web_search (fallback)
- **Booking partners**: Duffel (flights — live), Hotelbeds (hotels — pending),
  Lightspeed Golf / GolfNow (tee times — pending), Uber Guest Rides for
  ground transport (default; CarTrawler parked as fallback), OpenTable + Yelp
  Fusion (restaurants — Yelp data live, OpenTable pending), Trawick (insurance
  — pending)

## Layout

```
src/
├── app/
│   ├── api/
│   │   ├── trips/[tripId]/
│   │   │   ├── build/              # Quiz → trip generation
│   │   │   ├── book-all/           # Master commit step
│   │   │   ├── book-flight/        # Direct Duffel booking from modal
│   │   │   ├── refine-flights/     # Cheaper/Nonstop/Earlier/Later/Different
│   │   │   ├── itinerary-items/[itemId]/  # DELETE + /swap
│   │   │   └── workspace/          # Snapshot used by result page
│   │   ├── me/profile/             # PATCH saved traveler info
│   │   └── places/photo/           # Google Places hero photos
│   ├── build/[tripId]/             # Quiz route (NEW front door)
│   ├── trips/new/                  # Creates DRAFT, redirects to /build/[id]
│   ├── trips/[tripId]/             # Result page (LivePreview only)
│   └── dashboard/                  # Routes to /trips/[id] or /build/[id]
├── components/
│   ├── quiz/                       # QuizContainer, question views, loading
│   └── concierge/                  # LivePreview, dialogs, booking modal
├── lib/
│   ├── ai/                         # Orchestrator, agents, prompts
│   ├── bookings/providers/         # Duffel search/book/cancel, etc.
│   └── quiz/golf-questions.ts      # 15-question data-driven flow
└── prisma/schema.prisma
```

## Dev workflow (Windows / PowerShell)

```powershell
git pull origin claude/google-maps-chat-data-XqLnu
pnpm install
pnpm db:push        # syncs Prisma schema to Neon
pnpm check:env      # verifies env vars + DB connection — RUN FIRST when debugging
pnpm check:places   # verifies Google Places (New) key works
pnpm dev            # localhost:3000
pnpm typecheck      # tsc --noEmit
```

`pnpm db:push`, `db:migrate`, `db:studio`, `db:seed`, `check:env`,
`check:places` all go through `dotenv-cli` because Prisma CLI + Node scripts
otherwise read `.env` only, not `.env.local`.

## API key status (live)

✅ = working in `.env.local`. ⏳ = applied/waiting. ❌ = not yet applied.

| Provider | Status | Notes |
|---|---|---|
| Anthropic | ✅ | Required. Opus 4.7 + Haiku 4.5 |
| Neon (DB) | ✅ | `DATABASE_URL` = pooled (with `?connection_limit=5&pool_timeout=30` set in code), `DIRECT_URL` = direct |
| Clerk | ✅ | Real test keys |
| Duffel | ✅ test mode | Live flight searches work; bookings are sandbox PNRs. Apply for live mode at duffel.com dashboard — usually approved in 1-3 days |
| Tavily | ✅ | Web search |
| Google Maps (client) | ✅ | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — trip map widget |
| Google Maps (server) | ✅ | `GOOGLE_MAPS_SERVER_API_KEY` — Places photo lookup. Places API (New) must be enabled at project AND key restriction level (see `pnpm check:places`) |
| Yelp Fusion | ✅ | Restaurant data only — can't book |
| Stripe | ❌ | Bottleneck for any real money flow. Sign up takes 30 min |
| Resend | ❌ | Invite/confirmation emails |
| Hotelbeds | ⏳ emailed | Hotel inventory |
| OpenTable | ⏳ emailed | Real restaurant reservations |
| GolfNow | ❌ | Apply ASAP — biggest US tee-time inventory |
| Lightspeed Golf (Chronogolf) | ⏳ intake form filed | Independent courses |
| CarTrawler | ⏳ applied — **PARKED** | Pivoted to Uber-first; CarTrawler is fallback if/when approved |
| Trawick | 📝 filling out forms | Travel insurance |
| Uber Guest Rides API | ⏳ Central API access requested | The actual ground-transport integration. developer.uber.com/dashboard. Sandbox lets you build pre-approval — production needs the U4B grant |
| CJ Affiliate (publisher 7962835) | ⏳ Hertz application pending | Affiliate-link fallbacks for rentals/hotels/courses while direct integrations land. Apply to Marriott, Hyatt, Booking, Expedia, GolfNow, OpenTable in same dashboard |

## Working branch

**`claude/google-maps-chat-data-XqLnu`** — all current work lives here. Main
hasn't been merged in a while.

## Recent decisions / context

- **Quiz replaced the chat as the front door.** `/trips/new` → creates DRAFT,
  redirects to `/build/[id]`. 15 questions across "The trip / Course & vibe
  / The extras" sections with smart-skipping (typed destination skips
  course-style / difficulty / lodging / vibe questions). `/api/trips/[id]/build`
  runs destination + itinerary agents in a single pass + a live Duffel
  search. Quiz answers → `quizAnswersToConstraints` → existing agents.
- **Result page** at `/trips/[id]` is just the LivePreview (workspace chrome
  + chat killed). Shows: TotalsBanner ($X estimate + booked-so-far), "Pick
  your flight" cards with Cheaper/Nonstop/Earlier/Later/Different airline
  refinement chips, day-by-day itinerary with clickable item cards (open
  ItineraryItemDialog with hero photo + "Find alternative" + "Remove from
  trip"), and a copper **"Book all"** CTA that books real Duffel flights +
  records stub bookings for everything else. Once any booking exists the
  Pay CartFooter takes over.
- **Pricing rules are strict.** AI may only set `cost` on FLIGHT, LODGING,
  TEE_TIME, TRANSPORT items — never on DINING, SPA, ACTIVITY, NIGHTLIFE,
  FREE_TIME (those are unknowable up-front). `persistItinerary` defends this
  even if the prompt drifts: cost gets nulled, totals recomputed from the
  priced set only.
- **Reservations ≠ payments.** Every Booking row carries
  `metadata.paymentMode = "pay_now" | "pay_at_property"`. Hotels, golf,
  dining default to pay_at_property; flights and rental cars default to
  pay_now. The Pay CTA only totals pay_now bookings. Footer shows the
  pay_at_property total separately as "$X settles at the property."
- **Uber-first ground transport.** Quiz transport question leads with
  "Uber — Pyltrix default." Itinerary prompt explicitly defaults to Uber
  Black/LUX for every transfer in any market (including the "remote" golf
  destinations — Pinehurst, Bandon, Streamsong, Greenbrier, Equinox).
  CarTrawler chase paused; rental car only when user explicitly picks
  `rental_*` in the quiz.
- **Auto-book modal after quiz was removed.** Customers land on the result
  page first, swap/review items, then hit Book All. The auto-open was
  perceived as aggressive ("it doesn't book the freaking flights for me"
  vs. "I wasn't ready to commit").
- **Flight booking modal** (`flight-booking-modal.tsx`) is now a pure "save
  your traveler info" surface (Cancel + Done only — no Book button per
  Carson's explicit ask). Real flight booking happens via `book-all` or the
  per-card flow. Profile data (name/DOB/gender/email/phone) saves to
  `User` table for one-click bookings later.
- **Universal escape hatch on quiz questions.** Every single-select and
  multi-select supports `freeTextField` so users can type when none of the
  preset options fit. Particularly important on destination ("Pinehurst"),
  origin airport, group size (custom number), course style notes, etc.
- **Garbage destination detection.** `cleanDestination()` rejects bare
  pronoun fragments ("I want", "go somewhere", "whatever") so they coerce
  to null → destination agent runs → real place picked, not a confused
  itinerary defaulting to Pebble Beach.
- **Duffel Airways filter.** Sandbox placeholder carrier is hard-filtered at
  the search layer (`summarizeOffer`) so every caller gets clean results.
- **Google Places (New) requires BOTH:** the API enabled in the Cloud
  project AND included in the key's "API restrictions" allowlist. The
  `pnpm check:places` script recognises API_KEY_SERVICE_BLOCKED and prints
  the exact fix.
- **AI orchestration cost cut.** Old chat path was Opus 4.7 with multi-turn
  tool-use loops (~$0.30-$1.50/trip). New quiz path is bounded to one
  destination call + one itinerary call + one optional swap (Haiku) per
  user tweak (~$0.10-0.20/trip). Refinement chips on flights re-run Duffel
  with no AI call at all.

## Working with the user

- Carson is **non-technical / first-time engineer**. Explain commands and
  what they do; don't assume git/PowerShell fluency.
- Default OS is **Windows / PowerShell**, not bash. Translate Unix idioms.
- **VS Code's integrated terminal IS PowerShell** — Carson has asked "I'm
  running it in VS Code, not PowerShell" before. Be explicit about this.
- Be empathetic when env/setup debugging drags on — these problems compound.
- **Never paste real API keys or passwords in chat replies.** If exposed,
  mention rotation once briefly, move on.
- Carson sometimes copies commands from chat into PowerShell — that wipes
  the clipboard. Account for it.
- **Diagnostic logging > silent failures.** When something goes wrong (env,
  partner API, model error), the terminal should print the actual cause.
  See `check:env`, `check:places`, the `[places/photo]` logs, the
  `[book-all]` logs. Pattern: short tag + cause + suggested fix.

## Next-up priorities

1. **Stripe** — must do, 30-min signup, unlocks all real money flows. Then
   ~1 hour to wire checkout. **Now doubly critical** — it's also the vault
   + funding source for the browser-agent booking flow (see below).
2. **Duffel live key** — apply at duffel.com dashboard. Usually 1-3 days.
   Combined with Stripe = first real flight booking with real revenue.
3. **Per-companion saved profiles** so multi-traveler Book All works (today
   only the lead traveller has saved DOB etc.; group bookings get skipped
   at the flight step with a clear message).

## Browser-agent booking (planned architecture — SERIOUS, don't lose this)

The big bet for booking everything we DON'T have an API for — golf tee
times, beach clubs, restaurants, boat tours, activities, hotels, basically
any venue with a web booking form. Came out of looking at real venues
Carson visited (La Fontelina beach club + Lucibello boat tours in
Capri/Positano). Both have structured online booking forms; neither has
an API. A Claude-powered **browser agent** that fills these forms like a
human is the unlock — ONE agent generalises across venues (no per-site
scripts), because it reads the page visually instead of relying on
hardcoded selectors.

**Why it generalises:** the same agent that books Lucibello's boat tour
books a restaurant reservation, a beach club, a spa, **a tee time at any
independent golf course, and a room at any hotel's own website** —
anything with a web form. So "browser agent" = the booking engine for
~95% of the bookable surface of a luxury golf trip. The only things it
does NOT cover are (a) flights (Duffel) and (b) the big hotel
aggregators Booking.com / Expedia (use their affiliate clickouts — they
ban bots in ToS, and their affiliate programs are legit and fast to get
via CJ Affiliate where we're already approved as publisher 7962835).
This makes the agent the SPINE of the product, not a long-tail
nice-to-have. We can launch without GolfNow, TeeOff, Hotelbeds, or any
other pending API — the agent covers it.

**The decided payment flow (Carson + Claude worked this out in full):**
Money flows **Customer → Pyltrix → Vendor.** Concretely:
  1. Customer's REAL card is stored once in Stripe's vault (we never see
     or store the raw number — Stripe holds it, hands us a token).
  2. On "Book," we charge their real card for (vendor cost + our service
     fee). That money lands in OUR Stripe balance. **This is the moment
     Pyltrix earns revenue** — we take margin here (e.g. €3000 tour +
     €150 fee → pay vendor €3000, keep €150).
  3. **Stripe Issuing** generates a single-use VIRTUAL Visa card, funded
     from our balance, limit = exactly the vendor cost, locked to that
     one merchant. It is a REAL Visa with real money on it (NOT fake) —
     the vendor's checkout charges it like any card. Think "a real Visa
     gift card pre-loaded with exactly €3000 that only works at
     Lucibello, once."
  4. The agent types the virtual card into the vendor's checkout and
     completes the booking.
  5. The agent captures the vendor's REAL confirmation (order #, email)
     and we show that to the customer. When they show up at the desk,
     it's a genuine paid reservation in the vendor's own system.

**Why this design (decisions we already litigated, don't re-open lightly):**
- **Agent finishes the WHOLE booking incl. payment** — NOT a human
  handoff. We considered "agent fills form, customer types card at the
  end" but rejected it: any human handoff has a fragile seam (page
  refresh / session timeout / customer lands on a blank un-filled form
  and goes "what about the agent?"). Zero-seam = agent does it all.
- **Virtual/burner card, NOT the customer's real card typed by the
  agent.** Having our system touch a raw card number puts us in PCI-DSS
  scope at the highest tier (SAQ D) — a legal/certification landmine,
  NOT something we can engineer past with "good security." Card networks
  fine $5k–100k/mo; Stripe terminates us. The virtual card sidesteps all
  of it: Stripe holds the real card, the virtual number is worthless if
  leaked (single-use, one merchant, already funded). All the
  virtual-card plumbing is INVISIBLE to the customer — from their side
  it's one tap → "Booked ✓".
- **Fails visibly, never silently.** If a vendor rejects the virtual
  card (a few block prepaid) or the agent gets stuck, it surfaces the
  decline/error and falls back to "couldn't auto-book, here's the
  link/number to finish yourself." Never a fake "you're booked."

**Infra required (in order):**
1. **Stripe** (vault + the charge to the customer) — priority #1 anyway.
2. **Stripe Issuing** (generates the virtual cards) — a toggle once
   Stripe-approved.
3. **Browserbase** (or similar) — headless browser infra; can't run a
   persistent browser on Vercel serverless. ~$0.20/session. Agent loop
   adds ~$0.10–0.40 in Claude tokens per booking attempt. Reliability
   ~75–85%, so the visible-fallback above is mandatory.

**Build sequence:** `ReservationRequest` queue (step zero — captures
venue + date + party + traveler info so the agent has marching orders) →
Stripe + Issuing → Browserbase agent that drains the queue. The queue is
useful even before the agent exists: Carson (or a VA) drains it by hand
in seconds since the data's pre-captured. Same "concierge-by-hand for
the first ~30 customers" model Amex Centurion / Quintessentially used.

## API application checklist (in priority order)

This is the running checklist Carson is working through. When Carson
says "ok next one" or "what's next," look at this list, find the first
unchecked item, and walk him through that application. Update the
checkbox (`[ ]` → `[x]`) and commit when each one is submitted.

**Today's session ("apply for APIs day"):**

### Tier 1 — Golf inventory (the core product — apply first)
- [x] **GolfNow** (NBC Sports) — applied via direct email (not on CJ
      or Awin despite earlier assumption).
- [x] **TeeOff.com** (PGA Tour) — applied via teeoff.com business
      partnership form, Technology Partnership option.
- [~] **Amtrak** — deferred. Not on CJ (despite my earlier guess). No
      easy self-serve affiliate program found across major networks.
      Revisit post-launch with real Northeast Corridor traffic to
      justify direct B2B outreach.
- [ ] **Supreme Golf** — aggregates GolfNow + TeeOff + others.
      `supremegolf.com/api` → request enterprise access.
- [x] **KemperSports** — submitted via the contact form at
      kempersports.com/contact-us (the bare partnerships@kempersports.com
      address bounced as user unknown).
- [x] **Troon Privé** — submitted via troon.com/about/contact, "Other"
      category, supplemental info field carries the partnership pitch.
- [x] **Pinehurst Resort** — submitted via pinehurst.com/contact,
      routed through Meetings / Corporate Events category with an
      explicit "longer-term channel/partnership inquiry" prefix.
- [ ] **BRS Golf** — UK tee-time platform, covers Open Championship
      venues. `brsgolf.com/contact`.
- [ ] **GolfBreaks** — UK + European golf package operator.
      `golfbreaks.com/affiliates`.

### Tier 2 — Trains (Europe inter-leg transport)
- [ ] **Trainline Partner Solutions** — one API for UK Rail, Eurostar,
      Trenitalia (Frecciarossa), SNCF (TGV), Renfe (AVE), DB (ICE),
      ÖBB, SBB. `partner.thetrainline.com`. Carson wants the
      application copy drafted in his voice.

### Tier 3 — Ferries (Italian / Greek luxury trips)
- [ ] **Ferryhopper** — Mediterranean one-API: Italy, Greece, Spain,
      Croatia. `ferryhopper.com/en/business`. Drafted copy needed.

### Tier 4 — Luxury chauffeur + restaurants
- [x] **Blacklane** — emailed business@blacklane.com directly with
      the API/technology-partner pitch. Their self-serve travel-agency
      signup gated on an IATA/CLIA accreditation number we don't have
      pre-launch, so we went around it via the contact address surfaced
      on that same form. Stub already wired in
      `src/lib/bookings/providers/blacklane.ts`.
- [ ] **Resy** — covers Carbone, Don Angie, etc. that OpenTable misses.
      `resy.com/about/business`.
- [ ] **Tock** — Eleven Madison Park, Atomix, French Laundry tier.
      `exploretock.com/sales`.
- [ ] **Trawick** — travel insurance forms already in progress, finish.

**Already-applied / in-flight (do NOT re-apply — wait their 2-3 week
window):** Hotelbeds, OpenTable, Lightspeed Golf / Chronogolf, Uber
Guest Rides Central API, CJ Affiliate Hertz.

**Already approved:** Anthropic, Neon, Clerk, Duffel (test), Tavily,
Google Maps (client + server), Yelp Fusion, Awin (Radisson — merchant
id 7754, publisher id 2899389).

**Skipping deliberately:** CarTrawler (parked — Uber-first), Stripe
(30-min signup, do day-of), reapplying anything pending.

### How to drive the checklist

When Carson is ready: ask "ok what's next" or "give me the next one."
Then:
1. Read this checklist, find the first `[ ]` item.
2. Tell him exactly where to click / who to email, with the URL or
   email address from the list.
3. If the item needs application copy (Trainline, Ferryhopper,
   Blacklane, KemperSports email), draft it in Carson's voice — same
   pattern as the Awin description: 1-2 sentences on what Pyltrix is,
   one on why this partner specifically, one on volume expectation
   ("pre-launch, expect first bookings Q3 2026"). Keep under 225
   chars where the form has a limit.
4. After he submits, update `[ ]` → `[x]` in this file and commit
   with message `chore: tick off <partner> application`.
