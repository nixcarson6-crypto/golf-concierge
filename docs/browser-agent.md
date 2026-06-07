# Browser-agent + booking pipeline — working notes

> Handoff doc for the next Claude Code session. CLAUDE.md is the canonical
> project context (read it first); this file is the focused state-of-play
> for the **booking agent + Stripe card path** work specifically. Update
> this file as the work progresses.

## The thesis (don't relitigate)

Pyltrix books **the sure things** for the customer end-to-end so they
never have to think about logistics:

- ✈️ **Flights** → Duffel API (live, working)
- 🏨 **Hotels** → browser agent (Stagehand on Browserbase)
- ⛳ **Golf tee times** → browser agent
- 🚗 **Car rentals** → browser agent (only when it's an actual rental, not
  a per-ride Uber transfer — see `src/lib/bookings/agent-scope.ts`)

Everything else is **suggestions, not bookings**:

- 🍽️ **Restaurants** + 🎭 **activities / nightlife / spa** → render as a
  recommendation card with the venue's phone + website. No agent runs.
  Carson's explicit call: "we don't handle dining and activities; give
  them the suggestion with the number" (Dec 2026 conversation).

Why the split:
- Hotels/golf/rentals = irreversible, high-value, real money on the line.
  Worth automating.
- Restaurants = floating choice, no fixed destination, often bot-walled
  (DataDome on TheFork / Resy / OpenTable). Not worth fighting.

**Cars-vs-rides distinction matters:** trip transport items are mostly
per-ride Uber/chauffeur transfers ("Uber Black: AUS → Omni") which the
agent leaves alone — they're summoned in-app day-of. Only the rare
"Hertz / Luxury SUV rental" item is agent-bookable. The discriminator
is `isAgentBookable()` / `isCarRental()` in `src/lib/bookings/agent-scope.ts`.

## Agent architecture (current — Stagehand, DOM-driven)

The booking engine is **Stagehand v3** running on Browserbase. It
replaced the slow Claude-Computer-Use vision agent as the default
(`BOOKING_ENGINE=stagehand`, set in `src/lib/bookings/browser-agent/run-booking.ts`).
The vision agent is still wired as a fallback.

### Key files

| File | Role |
|---|---|
| `src/lib/bookings/browser-agent/stagehand-runner.ts` | The DOM-agent driver: opens a Browserbase session, navigates, runs the agent loop, handles payment, extracts the outcome. **The big concentrated file.** |
| `src/lib/bookings/browser-agent/run-booking.ts` | The orchestrator: loads booking + traveller + venue, runs `withAgentRun` for live progress, calls the runner, applies the skeptical verify gate, persists outcome. |
| `src/lib/bookings/browser-agent/goal.ts` | Builds the task message (venue, dates, party, budget, traveller) the agent receives. |
| `src/lib/bookings/browser-agent/outcome.ts` | `verifyOutcome()` — the skeptical brain. Refuses CONFIRMED without proof. 49 brain tests; `pnpm check:brain` to run. |
| `src/lib/bookings/browser-agent/card-provider.ts` | Just-in-time payment closure. Charges customer + mints virtual card. Now takes `observedAmountCents` from the page (hotels carry no upfront price). |
| `src/lib/bookings/browser-agent/agent.ts` | Legacy computer-use vision agent (fallback). |
| `src/lib/bookings/agent-scope.ts` | Single source of truth for "what does the agent book" — shared by UI panel + book-agent endpoint so they never drift. |

### Stagehand config (lean prompt is the speed lever)

The `STAGEHAND_SYSTEM` prompt is in `stagehand-runner.ts`. Keep it tight —
it's re-sent on every step. Current shape:

- **STEP 0 — clear cookie banners** (multi-language: Accept / Accetta tutti / Aceptar / Zustimmen / Tout accepter)
- **Core rules:** finish the booking; one submission only; CONFIRMED requires proof; never invent data; never exceed budget; payment is two-phase
- **Dates section:** type into text fields OR use calendar arrows; always set the requested date BEFORE reading availability (sites default to "today" and falsely show sold-out)
- **Three playbooks:** HOTEL, GOLF, CAR-RENTAL — explicit step-by-step
- **Hard rule:** room/vehicle type in task is a **preference**, never a hard requirement. Quitting because "Junior Suite" isn't listed is a failure
- **Hard rule:** when you see Reserve/Book buttons, **CLICK ONE.** Multiple rates for the same room → cheapest that fits budget. Sitting on a rate list = same failure as quitting
- **NEVER STOP SILENTLY** — if can't proceed, say WHY with exact prices/labels

### Pre-agent speed passes (in `stagehand-runner.ts`, before the agent loop)

Two deterministic steps run once per session, BEFORE the LLM agent starts —
they cut fixed latency off every booking without touching the model:

- **Heavy-resource block** (`blockHeavyResources`) — a CDP
  `Network.setBlockedURLs` denylist drops analytics / ad / session-replay
  hosts + raw video (`HEAVY_RESOURCE_BLOCKLIST`). The DOM agent reads the
  a11y tree, not pixels, so none of it is needed; on media-heavy luxury
  sites it's the bulk of what a page waits on. **Deliberately leaves CSS,
  images, fonts, and recaptcha/gstatic/cloudflare-challenge alone** so
  layout, confirmation reads, and captcha solving are unaffected. Disable
  with `BROWSER_AGENT_BLOCK_HEAVY=false`.
- **Deterministic consent dismissal** (`dismissConsentDeterministically`) —
  an in-page DOM pass clicks the accept control of the common consent
  managers (OneTrust / Cookiebot / Didomi / Usercentrics) or any visible
  button labelled Accept/Agree/OK/Allow in 7 languages. One CDP round-trip,
  **no LLM call.** The old `stagehand.act()` consent clear (~5-10s every
  run) is now only the BACKSTOP, used when the fast pass finds nothing.

### Per-type step budgets (set in `run-booking.ts`)

- `LODGING`: 55 steps (longest flow)
- `TRANSPORT` (rental): 45 steps
- Everything else: 35 steps
- Wall clock: 10 min hard cap

### Split-model setup

- `model` (planning): `claude-sonnet-4-6` — the brain
- `executionModel` (per-action): `claude-haiku-4-5` — the fast workhorse
- Don't downgrade Sonnet → Haiku for planning; Haiku can't hold the
  multi-step plan ("if Haiku can't handle it, get Sonnet and make Sonnet
  faster" — Carson)

## Stripe card path (just built — NOT yet validated)

**Status: code complete, typecheck clean, 49 brain checks pass. NOT
tested with real Stripe yet.**

### What's wired

| Piece | File | State |
|---|---|---|
| Customer vault + charge | `src/lib/payments/customer-charge.ts` | Pre-existing, solid |
| Issuing (mint/reveal/cancel virtual card) | `src/lib/payments/issuing.ts` | Pre-existing, solid |
| `<2s` auth webhook (THE security control) | `src/app/api/webhooks/stripe/route.ts` | Pre-existing, correct |
| Save-card flow (Stripe hosted Checkout, setup mode) | `src/app/api/me/payment-method/checkout/route.ts` | **NEW** |
| Save-card button | `src/components/concierge/save-card-button.tsx` | **NEW** |
| Setup-completion handler in webhook | `src/app/api/webhooks/stripe/route.ts` (mode=setup branch) | **NEW** |
| Stagehand payment phase (two-phase: detect → charge → mint → type) | `src/lib/bookings/browser-agent/stagehand-runner.ts` | **NEW** |
| Card provider takes `observedAmountCents` (page total = ground truth) | `src/lib/bookings/browser-agent/card-provider.ts` | **NEW** |

### Money flow

```
Customer's real card  →  Pyltrix Stripe balance  →  single-use virtual Visa  →  Vendor
   (in Stripe vault)      (we earn margin here)    (capped + merchant-locked)
```

1. Customer saves card via hosted Checkout setup mode (no PCI on us)
2. Agent books to the card-entry step, leaves card fields blank
3. Runner detects payment step + reads the **real grand total** off the
   page (most items have no upfront price — page total is source of truth)
4. `cardProvider(observedAmountCents)`:
   - Charges customer's saved card for `vendorTotal + 5% fee`
     (idempotency key = bookingId, so Inngest retries can't double-charge)
   - Mints a single-use virtual Visa capped at `vendorTotal × 1.15` or
     `+$20` (for tax/resort fees the vendor tacks on at the last click)
   - Persists card id + real cost on the Booking row
   - Reveals PAN/expiry/CVC just-in-time (never logged/persisted)
5. Runner calls one scoped `agent.execute()` with the card to type
6. Skeptical extract gate reads the confirmation off the post-pay page

### Safety properties (already encoded — do NOT regress these)

- `cardProvider` returns `unavailable` → clean `needs_review`, **no card entered, customer NOT charged**, when:
  - Stripe not configured
  - No saved card
  - No usable amount (page unreadable AND no budget on file)
  - Observed total >3× budget (misread guard against page parsing junk)
- Charge is idempotent on `bookingId`
- Single-use virtual card + auth webhook approves exactly one transaction at exactly the expected amount/merchant
- Card-entry fails after charge → `needs_review` with "payment secured, finishing manually" — never imply lost money
- Webhook fails closed (any doubt → decline) and must respond within 2s

### Validation owed before real money

1. **`pnpm check:stripe`** style end-to-end test script: save card → charge → mint → trigger auth webhook → confirm approval → cancel card
2. **Stripe test mode setup:** test keys + Issuing enabled + test funds via dashboard ("Issuing → Add funds")
3. **`stripe listen` + `stripe trigger issuing_authorization.request`** to validate the `<2s` webhook
4. **One real test booking** on a sandbox-friendly hotel with a test card (in test mode) — verify the full flow lands a confirmation
5. Currency caveat: we charge **USD**. Foreign-currency vendors (Belmond Splendido in EUR, etc.) are a known FX gap — US venues are clean

## Recent fixes (Dec 2026 session — Carson's Peru trip)

Three real bugs surfaced:

1. **Duplicate FLIGHT items.** AI emitted 4 items for a 3-pax trip (1 outbound + 3 identical $22,774 returns). Fixed at three layers:
   - Prompt: EXACTLY one FLIGHT per slice
   - `build/route.ts`: dedupe by `(from→to@date)` before Duffel runs
   - `rewrite-items.ts`: dedupe to `offer.slices.length`; map `item[i] → slice[i]`; apportion per-slice cost
2. **Slipped trip dates + missing internal hop.** Peru was Sep 19–29 but flights were Sep 21 / Sep 30, and there was no LIM→CUZ even though the itinerary had items in both cities. Fixed:
   - `build/route.ts`: SNAPS first FLIGHT date → `startDate`, last → `endDate`
   - Prompt: explicit "internal hops required" (Lima↔Cusco, Tokyo↔Sapporo, etc.)
3. **Hotel room undercount.** "Three Ocean View Suites" priced at one suite. Fixed:
   - `price-enrichment.priceLodging()` now takes `groupSize`, multiplies by `roomCountFor(item, groupSize)`
   - `roomCountFor`: `metadata.rooms` wins → description match ("Three Junior Suites" → 3) → "shared/double-occupancy" → `ceil(groupSize/2)` → default to `groupSize`

## Known gaps / what to tackle next

### Validation
- [ ] Run `pnpm check:brain` after every change to outcome/verify logic
- [ ] Build the `check:stripe` script (the actual money-flow validation, see above)
- [ ] One controlled end-to-end test with test Stripe + a hotel that
      accepts virtual cards

### Agent quality polish
- [ ] **Faster + cleaner runs.** Carson's bar: "extremely good, fast, efficient, correct, no errors." Real failures so far:
  - Six Senses Douro: reached rate cards, didn't click Reserve (likely budget mismatch — silent stop). Fixed with explicit "click Reserve when you see it" rule + "never stop silently" rule + louder logs (>40 char message check).
  - Hotel Saint George Marfa: quit because no "Junior Suite" exists. Fixed with "room name is a preference" rule.
  - Belmond Splendido: hit 35-step cap mid-flow. Fixed with per-type step budget (hotels = 55).
- [x] Cookie pre-clear is now **deterministic** (`dismissConsentDeterministically`
      in `stagehand-runner.ts`) — clicks the major consent managers + multi-
      language Accept buttons in one CDP round-trip with no LLM call, falling
      back to `act()` only when the DOM scan finds nothing. Still worth a live
      smoke on Finca Cortesin to confirm the selector/label list covers it.
- [ ] Iframe card-field detection (some payment processors put the card form in a child frame — Stagehand should handle but unconfirmed at real checkouts)

### Booking.com API (Carson is pursuing)
- If/when this lands, route hotels covered by Booking.com through that
  API (clean reservation, no agent stalls, no deposit-wall problem since
  it's a real reservation API). Browser agent stays for independent
  luxury properties not on aggregators (Belmonds, Finca Cortesins, the
  Six Senses long-tail).

### Itinerary quality (continuous)
- Empty days at trip start (Carson's Peru showed Sep 19, 20 with no
  items) — AI tends to start activities a day or two after trip start
- Carson's Peru Sep 23 had only a 9 PM cocktail — pacing edge case

## How to run / validate

```powershell
# Carson's environment is Windows + PowerShell + pnpm
pnpm install
pnpm db:push                     # syncs Prisma to Neon
pnpm check:env                   # verifies env + DB connection
pnpm typecheck                   # tsc --noEmit
pnpm check:brain                 # 49 adversarial outcome cases — MUST PASS
pnpm dev                         # localhost:3000

# When wiring Stripe testing:
pnpm check:stripe                # placeholder — needs build-out
stripe listen --forward-to localhost:3000/api/webhooks/stripe
stripe trigger issuing_authorization.request
```

## Working branch + conventions

- Branch: `claude/google-maps-chat-data-XqLnu` (main hasn't been merged in months)
- Commits: imperative present, lowercase verb ("fix:", "feat:", "change:"), explain WHY in the body
- Never push to main without explicit permission
- Carson is non-technical / first-time engineer — explain commands, translate Unix idioms to PowerShell, no jargon dumps
- Don't paste real API keys in chat — if exposed, mention rotation once, move on

## Tone for the next chat

Carson is tired and has been through many rounds on this. Be direct and
honest:
- Don't oversell — if something's untested, say so. The Stripe path
  isn't proven yet; don't promise it works end-to-end
- When something fails (and it will), look at the actual log + screenshot
  before guessing. The Marfa / Splendido / Six Senses fixes all came
  from reading exactly what the agent did
- "Polish forever" without validation is worse than "test once, fix the
  real thing"
- Don't say "best ever" — say "let's make this run finish cleanly"
