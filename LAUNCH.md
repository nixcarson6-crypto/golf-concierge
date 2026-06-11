# Launch punch-list — do these in order

Tight, sequenced steps to get Pyltrix live (invite-only, real bookings).
Everything code-side is done and pushed; what's left is mostly signups,
approval clocks, and one deploy decision. Start the clocks (★) FIRST so
they tick while you do the rest.

Branch with all the work: `claude/google-maps-chat-data-XqLnu`

---

## 0. Sync your Mac (2 min)

```
git pull origin claude/google-maps-chat-data-XqLnu
pnpm install
pnpm db:push          # picks up the HOTELBEDS provider + any schema bits
npx prisma generate   # refresh the DB client
```

---

## 1. ★ Start the approval clocks (15 min, then they run on their own)

These take 1–3 days to approve — submit TODAY so the waiting happens in
the background.

- **Stripe** — stripe.com → sign up. This is THE gate for real money
  (charging customers + Stripe Issuing for the agent's virtual cards).
  Live mode wants a business entity (see step 2).
- **Duffel live key** — duffel.com dashboard → apply for live mode.
  Real flight tickets need it; test mode books sandbox PNRs only.

## 2. ★ File the LLC (same-day online)

Texas LLC filing. Stripe live mode + a business bank account both want it.
This is the gating item behind Stripe — do it first thing.

---

## 3. Email (Resend) — ~30 min, key is instant

The whole email system is already wired (welcome email on signup +
booking-confirmation after Book All + agent "Booked ✓" proof). It just
needs a key.

1. resend.com → sign up → copy the API key (`re_...`).
2. Add to `.env.local`:  `RESEND_API_KEY=re_...`
3. Test it:  `pnpm check:email`
   - Sends the welcome + a sample booking-confirmation to nixcarson6@gmail.com.
   - The default sender (onboarding@resend.dev) only delivers to YOUR
     Resend account email — that's fine for the test.
4. Later (before real customers): in Resend, verify the `pyltrix.com`
   domain, then set `RESEND_FROM_EMAIL="Pyltrix <hello@pyltrix.com>"` so
   it can email anyone.

## 4. Validate the hotel stack (5 min — already wired)

```
pnpm check:liteapi       # LiteAPI sandbox booking
pnpm check:hotelbeds     # Hotelbeds sandbox book + cancel
```
Both should 🎉. Hotels book LiteAPI → Hotelbeds → browser agent.

## 5. Prove the browser agent (the risky unknown — ~1 hr)

The day's deferred test. Open a trip with **Schlosshotel Kitzbühel**, hit
"Book it for me", and confirm the agent reaches the PAYMENT step in under
4 minutes. All the traps it hit before (newsletter popup, German labels,
chatbot) are handled now. This tells us if "agent working good" is done or
needs another pass.

---

## 6. Deploy the REAL app to pyltrix.com (the one deploy decision)

Right now pyltrix.com serves the static `coming-soon/` page (Vercel project
`golf-concierge`, Root Directory = `coming-soon`). To put the actual app
live you change that project (or make a new one) so it builds the Next.js
app from the repo root instead:

- Vercel → golf-concierge project → Settings → **Root Directory** → change
  from `coming-soon` to the repo root (blank), Framework = Next.js.
- Add ALL the `.env.local` vars into Vercel → Settings → Environment
  Variables (DATABASE_URL, Clerk keys, ANTHROPIC, LITEAPI, HOTELBEDS,
  RESEND, Stripe, Browserbase, Google, etc.).
- Set the Clerk webhook URL to `https://pyltrix.com/api/webhooks/clerk`
  (so signups upsert users + fire the welcome email).
- Production branch: decide if `main` is the live branch (then we merge the
  feature branch into main) — ask Claude to do the merge safely.

> Alternative for a soft launch: keep coming-soon at pyltrix.com and put the
> app at app.pyltrix.com. Ask Claude which is cleaner for your setup.

---

## What's already DONE (don't redo)

- ✅ Quiz → AI trip build → result page → Book All
- ✅ Hotels: LiteAPI + Hotelbeds wired & validated (sandbox)
- ✅ Wrong-hotel matching bug fixed in both hotel APIs
- ✅ Flights: Duffel (test mode)
- ✅ Browser agent: built, trap-handling + 4-min cap (needs the proof run)
- ✅ Emails: welcome + booking confirmation wired (needs Resend key)
- ✅ Sign-up: Clerk wired with real test keys
- ✅ Landing page redesigned + LIVE on pyltrix.com
- ✅ RateHawk: registered, account manager (Gary) assigned, email drafted
- ✅ Expedia: applied (denied pre-launch — reapply post-launch)

## Honest timeline

~2 days of your hands-on work, gated by Stripe's 1–3 day approval clock.
Realistic: **live in test mode in ~1 day, taking real money in ~3–5 days.**
RateHawk is a bonus, NOT a blocker — don't wait on it.
