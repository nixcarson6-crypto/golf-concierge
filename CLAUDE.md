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
- **AI**: Anthropic Claude — `claude-opus-4-8` for orchestration,
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
| Anthropic | ✅ | Required. Opus 4.8 + Haiku 4.5 |
| Neon (DB) | ✅ | `DATABASE_URL` = pooled (with `?connection_limit=5&pool_timeout=30` set in code), `DIRECT_URL` = direct |
| Clerk | ✅ | Real test keys |
| Duffel | ✅ test mode | Live flight searches work; bookings are sandbox PNRs. Apply for live mode at duffel.com dashboard — usually approved in 1-3 days |
| Tavily | ✅ | Web search |
| Google Maps (client) | ✅ | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — trip map widget |
| Google Maps (server) | ✅ | `GOOGLE_MAPS_SERVER_API_KEY` — Places photo lookup. Places API (New) must be enabled at project AND key restriction level (see `pnpm check:places`) |
| Yelp Fusion | ✅ | Restaurant data only — can't book |
| Stripe | ❌ | Bottleneck for any real money flow. Sign up takes 30 min |
| Resend | ❌ | Invite/confirmation emails |
| LiteAPI | ✅ sandbox | PRIMARY hotel booking API — wired (`LITEAPI_KEY`). Search-by-hotelId → prebook → book; agent fallback for uncovered. `pnpm check:liteapi` |
| Hotelbeds | ⏳ emailed | Hotel inventory — apply via developer.hotelbeds.com (self-serve test keys). 2nd hotel API. |
| OpenTable | ⏳ emailed | Real restaurant reservations |
| GolfNow | ❌ | Apply ASAP — biggest US tee-time inventory |
| Lightspeed Golf (Chronogolf) | ⏳ intake filed + dev-partner application in progress | PRIORITY tee-time API (Partner API v2, books into the course's own tee sheet). Apply: lightspeedhq.com/partners/developers/ |
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

### 🔴 RESUME HERE — ACTIVE FIX: make the agent reach the card step in ~4 min on EVERY hotel

**The goal (Carson's exact words):** "complete Aman in about 4 min, get to the
card step" — and **the fixes must be GENERAL (apply to every booking form), not
per-site patches.** We are NOT chasing individual resorts anymore; each fix has
to cascade to all hotels.

**Where we are:** the deterministic "conductor" + the browser agent drive most
luxury hotels to the CARD STEP correctly (One&Only ~3:30). But Aman/SynXis-class
sites still take ~6 min and the two slow phases are:

1. **DATES (~2:40 on Aman Venice / SynXis "revraise" engine).** The ARIA-grid
   date-setter (`clickStayDatesDeterministically`, Strategy 0 — `[role=gridcell]`
   + `date`/`aria-label` resolution + month nav) cracks One&Only but on Aman
   Venice it only logged `ADVANCING` then handed off, so the **AI finished the
   date clicks slowly**. FIX NEEDED: on SynXis the setter must actually CLICK
   both arrival + departure cells (not just advance the month) and confirm them,
   so dates complete deterministically in seconds. Likely the OUT date returns
   `out=PENDING` and never gets clicked, or the cell `.click()` doesn't register
   on revraise. Get the diag HTML if needed (`🔬 calendar diag` logs the
   calendarHTML) and make the gridcell click stick.

2. **GUEST INFO / payment form (~150s on Aman, often times out empty).** The
   screenshot showed the SynXis guest+card form with EMPTY required fields at
   timeout — `deterministicGuestFill` did NOT fill it. FIX NEEDED: make autofill
   reliably fill the SynXis "revraise" guest form (First/Last/Email/Confirm
   Email/Phone + the `+49` country-code dropdown → set to +1; Prefix; Billing
   Address) the instant it renders, so the AI doesn't transcribe field-by-field.
   The `⚡ autofill completed N fields` line should fire with N≥6 on this form.

**Target:** dates deterministic (~10s) + room/rate/enhancements deterministic
(already working) + guest autofill (~5s) = Aman to the card step in ~3–4 min.
Cap is currently **6 min** (`BROWSER_AGENT_TIMEOUT_MS` || 360_000) — leave it at
6 unless these fixes land it under 4 reliably.

**Hard truth to keep stating to Carson:** the agent fills everything UP TO the
card step; it **cannot click "Pay/Confirm" without Stripe Issuing** (the virtual
card). Today every booking stops at the card step → NEEDS_REVIEW → concierge,
because there's no card. **Stripe + Issuing is the real finish line for true
hands-free booking** — it's a one-time integration, NOT more agent code. Carson
does NOT want the concierge-by-hand model long-term; he wants the agent to
complete it, which REQUIRES Stripe.

**Testing notes (so a fresh session reads logs right):**
- Local dev is single-threaded: the result page's `/workspace` poll + SSE
  compete with the agent on ONE Node thread, inflating every step ~2×. In
  production (separate worker) it's much faster. Don't over-index on local times.
- Carson sometimes hovers/clicks the live Browserbase view mid-run — that fights
  the agent (same browser). Tell him: don't touch the live view while it runs.
- `awaitActivePage: no page available` = Browserbase session CRASH (infra, ~85%
  reliability), not our logic — it auto-retries, doubling time.
- Test HARD-BUT-BOOKABLE sites (real online checkout). Skip inquiry/members-only
  (Bandon "Plan My Trip", Breakers golf, Punta Mita pro-shop, Aman GOLF) — those
  have NO online booking and correctly route to links/concierge.

### ✅ DONE THIS SESSION (agent hardening — all on `claude/google-maps-chat-data-XqLnu`)
- **Calendar generalized:** ARIA `[role=gridcell]` date grid w/ full-date
  resolution (date attr / aria-label / day+header) + MONTH NAVIGATION (click
  next-month to reach the target month). Cracks One&Only, SynXis, mwl-calendar.
- **Room / rate-plan / enhancements pickers** all deterministic + the rate-plan
  "second priced list" (Reserve cards) handled; gated by calendar-step guard.
- **Guest autofill** + **state inferred from PHONE AREA CODE** (903→Texas), not
  the flight origin.
- **Anti-spam caps:** advance "Next" and book-CTA "BOOK NOW" stop after a few
  identical clicks (Bandon/Hammock loops); month-hop capped at 14.
- **Golf:** picks real EZLinks/ForeUp slots, 2nd-earliest when requested time
  unavailable, rate picker skips currency options, cart→checkout deterministic;
  members-only / pro-shop / preview-only courses bail fast to phone+concierge.
- **No-availability → "Find a nearby course"** (swap is now proximity-mandatory).
- **6-min cap** → timeout routes to concierge as NEEDS_REVIEW (not a red failure)
  with an honest "this site is slow, concierge finishing it" message.
- **Cars removed** entirely (quiz + itinerary + booking).
- **Receipt card** on confirmed bookings (conf # + exact dates + total).
- **Resort-golf** framed as "concierge arranges it with your stay" + queue links
  the hotel booking.
- **Destination diversity:** course-style button → market type; "hidden gem"
  avoids famous names; no Bandon/Pinehurst on repeat.
- **Safety net:** no booking can strand in SEARCHING (watchdog + catch → queue).
- **Build fail-fast + Opus→Sonnet fallback** when Opus overloads.
- **Kill switches:** `NEXT_PUBLIC_BOOKING_LINKS_ONLY` (golf=links) and
  `HOTEL_AGENT_DISABLED` (APIs only, link the rest).

### P0 — this week (critical path)

| Task | Why | Effort |
|---|---|---|
| **Wire "Book it for me" button + endpoint + Inngest fn** | Connects the proven agent to the actual app. Carson sees real one-tap booking. | ~3 hrs |
| **"Save your card" UI** (Stripe.js SetupIntent) | Customers add their card once; required before agent can book paid venues. | ~2 hrs |
| **Live booking-status states on item cards** (Booking… / Booked ✓ / Needs review / Fallback) | Makes the agent's work visible to the customer in real time. | ~2 hrs |
| **Apply: Stripe live mode** | 1-3 day approval window — submit early. | 30 min |
| **Apply: Duffel live key** | Same 1-3 day window. Real flight bookings need it. | 30 min |

### P1 — next week (launch readiness)

- **Browserbase ~$39/mo tier + flip `BROWSERBASE_PREMIUM=true`** — captcha
  solving unblocks La-Fontelina-class venues. Day-of-launch only;
  don't pay during testing.
- **Real end-to-end test bookings** — Carson takes 3-5 trips for real to
  find failure modes before paying customers do.
- **pyltrix.com production deploy** — currently localhost.
- **Result-page polish pass** — last-mile UX.
- **LLC / business entity** — required for Stripe live anyway.

### P2 — post-launch (v1.1, after first paying customers)

- Per-companion saved traveler profiles (group bookings beyond lead).
- Pyltrix-controlled inbox for vendor confirmation emails (concierge polish
  that consolidates 8 venue emails into one).
- "Book everything" checkbox version of Book-All.
- Custom failure messages per venue type.

### CUT from v1 (deliberate — resist building these)

- Self-healing trips (auto-rebook on disruption).
- Voice intake / voice rebooking.
- Memory / cross-trip personalization.
- SMS / push notifications.
- Auto trip-recap with photos.
- Per-trip Pyltrix inbox (the email-forwarding polish).
- **Any pre-launch partner API applications** — Carson's call: GolfNow
  rejected us pre-website, the browser agent makes API partners optional,
  applications are wasted motion until pyltrix.com has real traffic +
  the company exists as an entity. *Exception:* warm leads where the
  partner is already engaged in conversation (e.g. the Supreme Golf
  call — see below).

## Supreme Golf call prep

Carson has a scheduled call with Supreme Golf for API access. This is
RADICALLY different from the cold applications that have been rejected —
they're already interested, so the pre-launch rejection bias doesn't
apply. Worth real prep.

**Why Supreme Golf is a legitimate add-on (vs. the agent):**
- Aggregates GolfNow + TeeOff + direct courses in one feed → one
  integration covers ~3 inventory sources.
- API tee-time lookups are FAST (seconds) vs. agent runs (~3 min).
  Lets the quiz surface live availability before booking, not just at
  the booking step. That's a real product-experience upgrade.
- Doesn't replace the agent — the agent still books independent courses
  Supreme Golf doesn't aggregate, plus everything non-golf.

**What to lead with on the call:**
> "Pyltrix is an AI luxury golf travel concierge at pyltrix.com.
> Customers answer a quiz, our AI builds a complete bookable trip —
> flights, lodging, tee times, dining, transport — and we book it all
> end-to-end. We want Supreme Golf as our primary tee-time inventory
> source because aggregated coverage matters for multi-destination
> luxury golf trips."

**What they'll likely ask + how to answer:**
- Site URL → `pyltrix.com`
- Business entity → "LLC in formation" (or active if Carson's done it)
- Current booking method → "Direct customer bookings today; we want
  Supreme Golf as our primary tee-time API going forward."
- Expected volume → "Pre-launch; first bookings Q3 2026. Conservatively
  20-50 tee times/month at launch, scaling with our trip volume."
- Payment processor → "Stripe."
- Integration timeline they need → ask THEM what's typical.

**Questions to ASK them (shows seriousness):**
- Sandbox / test environment available?
- Minimum volume commitments?
- Commission split (transparent on rate + their cut)?
- What does their integration timeline typically look like
  (sandbox → certification → production)?
- Coverage map — which destinations have the strongest inventory?

**DO NOT mention the browser agent.** It's a defensive moat / fallback,
not a sales pitch. Lead with the customer experience.

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

### Tier 0 — HOTEL APIs (the priority — instant, reliable hotel booking)

**Architecture (decided June 2026):** hotels book **API-first** via a bedbank,
with the **browser agent as fallback** for properties no API carries
(Aman, Pinehurst/Pebble/Bandon resort-direct). Selection is API-BLIND — the
itinerary AI picks the BEST hotel for the customer; we only choose
API-vs-agent at booking time. Each new hotel API slots into the same
`BookingProvider` registry pattern as LiteAPI (resolve name→id → rate-by-id
→ prebook → book → persist; any miss → agent). Adding more bedbanks just
shrinks the agent's share.

- [x] **LiteAPI** — WIRED + validated (sandbox). `LITEAPI_KEY` in
      `.env.local`. Covers most luxury in real markets (Florence Four
      Seasons/St. Regis, Milan, Splendido Portofino/Belmond) in 3–9s; misses
      Aman + US golf-resort-direct (agent's job). `pnpm check:liteapi`
      validates the full booking flow. **Key learning: search rates BY
      hotelId, not city name (city search is unreliable).**
- [x] **Hotelbeds (HBX Group / APItude)** — WIRED (sandbox, June 2026).
      Self-serve test key obtained at developer.hotelbeds.com (no form!).
      `HOTELBEDS_API_KEY` + `HOTELBEDS_SECRET` in `.env.local`; per-request
      SHA-256 signature auth. Provider mirrors LiteAPI: availability by
      GEOLOCATION (Google-geocode the hotel, search a 5 km radius, match by
      name — skips destination-code mapping) → checkrates if RECHECK → book
      → cancel. Hotels now book LiteAPI → Hotelbeds → browser agent.
      `pnpm check:hotelbeds` validates end-to-end (books + cancels near
      Palma). Production keys: apply once live. Deep European + leisure
      luxury (Italy/Croatia/Ireland trips). Also has Activities + Transfers
      APIs on the same account — future upside.
- [x] **Expedia Rapid (EPS)** — applied June 2026 via the expediagroup.com
      partner form (business type: Online Travel Agency) — **DENIED**
      (pre-launch, no traffic; the predicted outcome). Reapply post-launch
      with real booking volume; they vet hard on turnover.
- [ ] **RateHawk (Emerging Travel Group)** — applying June 2026, the
      gettable Expedia alternative (B2B-friendly, accepts pre-launch
      agencies). ratehawk.com → register as Travel agency → request API
      test credentials from the dashboard / assigned account manager.
      Would slot in as the 3rd hotel API in the same provider chain.
- [~] **Booking.com** — DEPRIORITIZED. Their booking (Demand) API is
      partner-gated + hard pre-launch (wants traffic we don't have). The
      affiliate program is gettable but that's clickout, not API-booking.
      Revisit post-launch with real traffic.
- [~] **Tablet Hotels** — NOT viable: it's a curated CONSUMER luxury brand
      (Michelin-owned), no third-party booking API. If we want deeper luxury
      beyond Hotelbeds, target **RateHawk / Emerging Travel Group** instead
      (luxury-decent, B2B-friendly).

#### Draft application copy — Hotelbeds / Expedia Rapid (Carson's voice)
> Pyltrix (pyltrix.com) is an AI luxury golf-travel concierge — customers
> answer a short quiz and our AI builds and books a complete trip: flights,
> lodging, tee times, dining, transport, end-to-end. We want [Hotelbeds /
> Expedia Rapid] as a core hotel-supply source for our luxury leisure trips.
> Pre-launch; first bookings Q3 2026, conservatively 20–50 room-nights/month
> at launch, scaling with trip volume. Payments via Stripe; entity: LLC in
> formation.

### Tier 1 — Golf inventory

**⛳ STRATEGY UPDATED (Carson, June 9 2026): golf goes API-FIRST, agent
fallback — same architecture as hotels.** The agent proved it CAN book tee
times but is too slow (minutes per round vs seconds); after LiteAPI showed
how good API-first feels, Carson reversed the earlier "no golf APIs" call.
Priority door: **Lightspeed Golf Partner API v2**
(partner-api.docs.chronogolf.com — OAuth, registered partner apps; apply
via lightspeedhq.com/partners/developers/ + follow up on the previously
filed Chronogolf intake). It books DIRECTLY into the course's own tee
sheet, which also answers the old Golfscape objection (aggregator booking
never reached the pro shop — Lightspeed IS the course's system). Supreme
Golf remains the aggregator option for breadth. Agent keeps covering
courses on no-API platforms.

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
- [~] **Blacklane — PARKED (June 2026).** They replied (Alni, Inside
      Sales): API access requires **a minimum 50 bookings/month**,
      confirmed BEFORE they share docs/pricing. Chicken-and-egg gate
      we can't meet pre-launch. DECISION: park it — ground transport
      already defaults to Uber Black/LUX, and the browser agent can
      book any chauffeur's own site for the private-driver case, so
      Blacklane isn't critical path. A warm "we'll circle back at
      volume" reply is drafted in Gmail (keeps the door open). Revisit
      once we naturally hit 50+ ground bookings/month — then we qualify
      automatically. Stub still wired in
      `src/lib/bookings/providers/blacklane.ts`.
- [ ] **Resy** — covers Carbone, Don Angie, etc. that OpenTable misses.
      `resy.com/about/business`. **PRIORITY** — most premium-restaurant
      reservations on real itineraries route through Resy/OpenTable, so
      sanctioned access flips dining from "clickout" to fully
      auto-booked. Apply BOTH doors: (a) affiliate program (sanctioned
      deep links + commission, realistic pre-launch) and (b) the
      reservation/partnerships API (the bigger prize). Resy is
      Amex-owned, API is locked down — lead with affiliate, open the
      partnership convo. Draft copy below.
- [ ] **OpenTable — affiliate + API follow-up** — already emailed once
      (see in-flight list). **PRIORITY.** Follow up on that thread AND
      apply to the OpenTable affiliate program (Impact/their network →
      sanctioned referral deep links + commission, near-term yes). The
      full reservation API is partner-only; keep that as the parallel
      ask. The clickout feature already shipped — affiliate just makes
      each clickout earn + ToS-blessed. Draft copy below.
- [ ] **Tock** — Eleven Madison Park, Atomix, French Laundry tier.
      `exploretock.com/sales`.

#### Draft application copy — Resy (resy.com/about/business)

> Pyltrix is an AI luxury golf-travel concierge (pyltrix.com). Customers
> answer a short quiz and our AI builds a complete, bookable trip —
> flights, lodging, tee times, dining, transport — then books it
> end-to-end. Dining is core to these trips and the marquee restaurants
> our customers want (Carbone, Don Angie tier) are Resy-exclusive. We'd
> like to integrate Resy so we can place real reservations for our
> travelers — open to starting with your affiliate/referral program and
> growing into deeper API access. Pre-launch; first bookings Q3 2026,
> conservatively 30-75 covers/month at launch, scaling with trip volume.
> Payment processor: Stripe. Entity: LLC in formation.

#### Draft application copy — OpenTable RESERVATION API (Carson's ask:
the real API key, NOT affiliate deep links)

> Subject: Reservation API access — Pyltrix (AI luxury golf-travel concierge)
>
> Hi [name] — following up on my earlier note. I want to be direct about
> what we're after: programmatic reservation-API access (OpenTable
> Connect / booking API), not affiliate links.
>
> Pyltrix (pyltrix.com) is an AI luxury golf-travel concierge. A customer
> answers a short quiz; our AI builds a complete, high-end trip — flights,
> lodging, tee times, dining, transport — and books the whole thing
> end-to-end so the customer does nothing. Dining is central, and on
> nearly every itinerary the restaurants our customers want are on
> OpenTable. Right now that's the one piece we hand back to the customer;
> with API access it becomes seamless.
>
> Why this is good for OpenTable and your restaurants, specifically:
> - We're a NET-NEW demand channel, not a competitor — we send you
>   high-intent, high-spend covers (luxury golf travelers), often
>   prime-time and party-of-2-to-8, that wouldn't otherwise reach your
>   network.
> - Low no-show risk: we capture the traveler's card via Stripe and the
>   reservation is part of a paid trip, so these are committed diners.
> - Every booking carries full, accurate guest detail (name, party,
>   contact) straight from the API — clean covers, no phone tag.
>
> We'll do whatever your process requires — sandbox, certification,
> volume minimums, revenue share. Pre-launch; first real bookings
> Q3 2026, conservatively 50-100 covers/month at launch and scaling
> directly with trip volume. Stripe for payments, LLC in formation.
>
> Could we get 20 minutes with whoever owns API partnerships? I'll work
> around your calendar.

**Note on reality (don't lose this):** OpenTable's booking API is
partner-gated and historically hard pre-launch — they favor partners
with traffic. The email above leads with the API ask per Carson's
explicit wish ("I want an API key, not deep links"). If they say "not
yet, here's the affiliate program" — take it as the interim (it powers
the same clickout + earns commission) and keep the API as the standing
ask. Do NOT let the affiliate offer kill the API conversation; treat it
as step one of the partnership, not the endpoint.
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
