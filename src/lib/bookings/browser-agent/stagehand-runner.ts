/**
 * Stagehand-based booking runner — the FAST, DOM-driven engine.
 *
 * Why this exists: independent 2026 benchmarks put DOM-driven browser
 * automation (Stagehand, Browserbase) at ~89-90% reliability vs ~78%
 * for vision-based Computer Use, AND ~44% faster (Stagehand v3). Our
 * original agent (`agent.ts`) used raw Claude Computer Use — every
 * action was a ~10s screenshot → vision → guess-coordinates round-trip.
 * Stagehand reads the actual DOM and acts directly: no screenshots, no
 * coordinate-guessing, far less token spend.
 *
 * This runner owns its own Browserbase session (Stagehand creates it
 * with our captcha-solving + proxy + stealth settings) and drives the
 * booking with Stagehand's DOM agent, then EXTRACTS a structured outcome
 * from the final page with a Zod schema. The result feeds the same
 * skeptical `verifyOutcome` brain we already use — so the reliability
 * gate is unchanged; only the engine underneath got faster.
 *
 * v1 scope: handles the no-upfront-payment majority (golf tee times,
 * restaurant reservations, spa — all pay_at_property). For venues that
 * demand a card AT checkout, the agent is told to STOP and report
 * needs_review (same as the MVP card path) — the just-in-time card seam
 * for those lands next.
 */

import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import { env, optionalEnv } from "@/lib/env";
import { AGENT_VIEWPORT } from "./runtime";
import type { RawBookingOutcome } from "./outcome";
import type { CardProvider } from "./agent";

// Silence the Vercel AI SDK's "System messages in the prompt … security risk"
// warning, which fires on EVERY Stagehand step. Stagehand (AI SDK internally)
// passes our systemPrompt as a system message — correct and intended here —
// but it never sets `allowSystemInMessages`, and the SDK hard-prints the
// warning via console.warn with no global off-switch (verified in
// ai@5.0.196/dist/index.js). So: a surgical console.warn filter that drops
// exactly this one message and passes everything else through untouched.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (
    typeof args[0] === "string" &&
    args[0].startsWith(
      "AI SDK Warning: System messages in the prompt or messages fields",
    )
  ) {
    return;
  }
  _origWarn(...args);
};

/** Stagehand PLANNER model id — the brain that sequences the booking
 *  ("set the date → set the party → pick the room → fill guest details →
 *  submit"). SONNET: Haiku is fast at individual clicks but can't reliably
 *  hold a multi-step plan — it stalls on calendars (sat on June needing
 *  August for 28 steps) and re-reads room lists instead of advancing. The
 *  per-action work (the BULK of calls) still runs on Haiku via
 *  executionModel below, so most of the speed/cost stays Haiku; only the
 *  high-level plan is Sonnet. Override with STAGEHAND_MODEL per-deploy;
 *  set it to anthropic/claude-haiku-4-5 to go back to pure Haiku. */
const STAGEHAND_MODEL =
  optionalEnv("STAGEHAND_MODEL") ?? "anthropic/claude-sonnet-4-6";
// Default step cap. A restaurant/tee-time/spa reservation (navigate →
// reservations → date → party → time slot → name/email/phone → submit →
// confirmation) legitimately takes ~15-25 steps, so 35 is plenty AND
// keeps those FAST. Hotels are a different beast — date picker → search →
// room list → rate → guest details → checkout is a long flow that blew
// past 35 (Belmond hit the cap mid-flow). The caller passes a per-type
// budget via opts.maxSteps; this is the fallback. The wall-clock timeout
// is the real backstop either way.
const MAX_STEPS = Number(optionalEnv("STAGEHAND_MAX_STEPS")) || 35;

// Per-ACTION timeout (one act()/click()/extract() call inside a step).
// Stagehand's default is 45s — far too generous for our ~10-min wall clock:
// a single hung selector on a heavy site (Rocco Forte/Verdura's homepage was
// the case that exposed this) silently burns 45s doing nothing, and 2-3 of
// those exhaust the budget before the agent ever reaches room selection. We
// cap it at 25s: long enough for a legit slow action / aria-tree build on a
// big page, short enough that a genuine hang fails fast, hands the agent the
// "try a different description" hint, and lets it recover + keep making
// progress. Tunable per-deploy via STAGEHAND_TOOL_TIMEOUT_MS.
// 15s: inside a 3-minute booking budget, a single hung action may not cost
// more than ~8% of the clock. A legit action lands well under 15s; a hang
// recovers fast and the agent moves on.
const TOOL_TIMEOUT_MS = Number(optionalEnv("STAGEHAND_TOOL_TIMEOUT_MS")) || 15_000;

// Default Browserbase region when we can't infer one from the venue.
const DEFAULT_REGION = optionalEnv("BROWSERBASE_REGION") || "us-west-2";

/**
 * Pick the Browserbase region closest to the venue so the browser↔site
 * round-trip on EVERY action is short. Booking an Italian hotel from a
 * US-West browser sends ~25 clicks across the Atlantic and back — minutes
 * of pure latency. Matching the region to the venue's country is the single
 * biggest speed win on overseas bookings (Croatia / Italy / Turkey / UK).
 * Keyword match on the venue's address/location; falls back to DEFAULT_REGION.
 */
export function browserbaseRegionFor(location: string | null | undefined): string {
  const t = (location ?? "").toLowerCase();
  if (!t) return DEFAULT_REGION;
  // Europe + Middle East + Africa → Frankfurt (closest BB region).
  const EU =
    /\b(italy|italia|sicil|france|spain|espa|portugal|germany|deutschland|switzerland|swiss|austria|netherlands|belgium|ireland|scotland|england|wales|united kingdom|\buk\b|britain|greece|croatia|hrvatska|slovenia|denmark|sweden|norway|finland|iceland|poland|czech|hungary|turkey|t[uü]rkiye|morocco|monaco|amalfi|tuscany|taormina|positano|capri|dubrovnik|split|venice|venezia|rome|roma|milan|milano|paris|lisbon|lisboa|madrid|barcelona|st\.? andrews|ballybunion|algarve|dubai|abu dhabi|\buae\b|emirates|qatar|doha|saudi|bahrain)\b/;
  // East/South Asia + Oceania → Singapore.
  const APAC =
    /\b(japan|nippon|tokyo|kyoto|osaka|china|hong kong|singapore|thailand|bangkok|phuket|vietnam|malaysia|indonesia|bali|philippines|south korea|korea|seoul|australia|sydney|melbourne|new zealand|auckland|queenstown|fiji)\b/;
  // US East + Caribbean → Virginia.
  const US_EAST =
    /\b(new york|florida|carolina|georgia|virginia|massachusetts|boston|miami|orlando|atlanta|pinehurst|bahamas|caribbean|dominican|puerto rico|jamaica|turks|cayman|nassau|new jersey|connecticut|maine|vermont|pennsylvania|maryland|washington,? d)\b/;
  if (EU.test(t)) return "eu-central-1";
  if (APAC.test(t)) return "ap-southeast-1";
  if (US_EAST.test(t)) return "us-east-1";
  return DEFAULT_REGION;
}

/** Schema the agent extracts from the final page — maps 1:1 to our
 *  RawBookingOutcome so verifyOutcome can gate it unchanged. */
const stagehandOutcomeSchema = z.object({
  status: z
    .enum(["confirmed", "failed", "needs_review"])
    .describe(
      "confirmed ONLY if the page shows a real confirmation/reservation number or an explicit 'your reservation is confirmed' message. Otherwise needs_review or failed.",
    ),
  confirmationCode: z
    .string()
    .nullable()
    .describe("The exact confirmation/reservation/order number shown on screen, verbatim. null if none visible."),
  confirmationEvidence: z
    .string()
    .nullable()
    .describe("A short verbatim quote of the on-screen confirmation text. null if none."),
  amountChargedCents: z
    .number()
    .nullable()
    .describe("Amount charged in cents if a payment was taken, else null (most reservations pay at the venue)."),
  failureReason: z
    .enum([
      "declined_card",
      "no_availability",
      "members_only",
      "captcha_blocked",
      "login_required",
      "form_not_found",
      "budget_exceeded",
      "ambiguous",
      "timeout",
    ])
    .nullable()
    .describe("Set ONLY when status is failed. The specific reason. null otherwise."),
  message: z
    .string()
    .describe("One short sentence describing the outcome for the customer."),
});

export type RunStagehandOptions = {
  startUrl: string;
  /** System prompt (the booking rulebook) + the concrete task instruction. */
  system: string;
  task: string;
  /** Browserbase anti-bot toggles (same flags as the legacy runtime). */
  solveCaptchas: boolean;
  advancedStealth: boolean;
  /** Hard wall-clock budget for the whole booking. */
  timeoutMs: number;
  /** Per-booking step budget. Restaurants/tee-times are quick (~35);
   *  hotels need more (~55) for the longer date→room→rate→guest flow.
   *  Falls back to MAX_STEPS / the STAGEHAND_MAX_STEPS env when unset. */
  maxSteps?: number;
  /**
   * Just-in-time payment. When set, the runner drives the booking up to
   * the card-entry step, then calls this to charge the customer + mint a
   * single-use virtual card, and types that card in to complete payment.
   * When unset (or it returns `unavailable`), the runner stops at the
   * payment step and reports needs_review — no card is ever entered.
   */
  cardProvider?: CardProvider;
  /** Live progress callback → wire to updateProgress for the UI. */
  onStep?: (label: string) => void | Promise<void>;
  /** Browserbase region (us-west-2 / us-east-1 / eu-central-1 /
   *  ap-southeast-1). Set to the region nearest the venue so every action's
   *  round-trip is short. Defaults to DEFAULT_REGION when unset. */
  region?: string;
};

export type RunStagehandResult = {
  outcome: RawBookingOutcome;
  /** Browserbase session-replay URL for the proof/debug surface. */
  sessionUrl: string | null;
  /** Base64 PNG of the final confirmation page — the customer's "Booked ✓"
   *  proof. Null when the run failed before a proof-worthy page, or the
   *  capture timed out. */
  finalScreenshot: string | null;
};

/**
 * Payment addendum for the DOM agent. v1 has no just-in-time card tool,
 * so the agent must NOT enter any card. The majority of agent bookings
 * (golf tee times, restaurant reservations, spa) are pay-at-property
 * and complete WITHOUT a card. For the minority that demand a card at
 * checkout, the agent stops and the booking surfaces as needs_review.
 */
/**
 * LEAN system prompt, purpose-built for the Stagehand DOM agent.
 *
 * The original goal.ts system prompt is ~3,000 words written for the
 * vision/computer-use agent — full of "take a screenshot", "alt+F2",
 * coordinate instructions, batch-actions-per-turn, etc. that the DOM
 * agent doesn't use. Re-sending that wall of text on EVERY step was the
 * main reason each step took 5-30s and bookings burned huge token
 * counts (Carson's 28-step, 6-minute, credit-draining runs). This is
 * the same rules, tight — only what the DOM agent needs.
 */
const STAGEHAND_SYSTEM = `You are Pyltrix's booking agent. You book HOTELS, GOLF TEE TIMES, and CAR RENTALS — nothing else. You have FULL AUTHORITY to complete the reservation on the customer's behalf: clicking buttons, picking rooms/time slots/cars, typing details, and submitting the form ARE your job. The customer already authorized this. Don't stop "to let the customer review" — there is no review step. Either finish the booking or report exactly why you can't.

Make ONE real reservation at the venue in the task — for the EXACT date(s)/party given — then stop. Be FAST and decisive: ~8-15 steps (hotels at most ~20). Never re-read a page you've already seen, and never scroll just to explore — decide and act.

STEP BUDGET CHECKPOINTS (count your own steps):
- By step ~5 you should be PAST the homepage with dates being set. Still on the homepage at step 5 → stop exploring, click the most direct Book/Reserve path NOW.
- By step ~12 you should have search results / a room or slot list on screen.
- Past step 20 and not yet on the guest-details form → no more comparing or reading: take the single most direct action toward checkout on every remaining step.

BATCH YOUR ACTIONS. Each turn is expensive, so do as much as you safely can per turn: when several fields sit together (check-in + check-out + guests; or name + email + phone), fill them ALL in one turn, then move on — don't spend a separate turn per field. On a HEAVY/slow page, cap a single fill at ~4 fields — if a fill TIMES OUT, do not retry the same big batch: split it into 2-3 fields per call and keep moving. Generally trust an action worked and continue; the ONE exception is the DATE fields (the most failure-prone step) — glance that the dates actually took. Acting on what's already on screen beats taking another look.

NEVER SPIN ON ONE THING. If you do the SAME action 2-3 times and the page/field hasn't changed, that approach is NOT working — STOP repeating it and switch tactics (type instead of click, click a different element, scroll to it, reopen the widget, or move to the next field). Repeating a failing action until the clock runs out is the #1 reason a booking never finishes. You have ~3 minutes total — spend it making PROGRESS, not retrying the same dead move.

SUPPORTED ACTIONS ONLY: click, fill, type, press, scrollTo, selectOptionFromDropdown, hover, doubleClick, dragAndDrop. To REPLACE the text in a field (e.g. a pre-filled date), just FILL it — fill overwrites the existing value. NEVER try to select-all first and NEVER request unsupported methods like tripleClick — every unsupported request is a wasted step that books nothing.

ONE TAB ONLY. Clicking a "Book"/"Reserve"/"Book Accommodations Online"/"Reservations" link often opens the booking engine in a NEW browser tab. Click it ONCE, then WORK IN THE TAB THAT OPENS — continue the booking there. Do NOT click that same link again, and do NOT go back to the original page and re-click it: every re-click spawns ANOTHER duplicate tab, re-does work, and burns the clock (a real run opened 9 tabs this way). If you already opened the booking page, it exists — switch to it and proceed; never re-open it.

STEP 0 — CLEAR THE PAGE FIRST (before anything else, on EVERY new page): if a cookie / consent / privacy / GDPR banner or modal shows, DISMISS IT by clicking the most permissive accept button — "Accept", "Accept all", "I agree", "OK", "Got it", "Allow all", or in another language "Aceptar"/"Accetta tutti"/"Zustimmen"/"Tout accepter"/"Alle akzeptieren". These overlays sit ON TOP of the page and intercept every click — if you don't clear it, nothing works and you stall. Clicking accept is always safe.

TRAP OVERLAYS & DEAD-END FORMS — CLOSE or SKIP, never engage (these have eaten whole runs):
- NEWSLETTER / VOUCHER FORMS, popup OR in-page: a modal offering a discount/gift ("€50 geschenkt", "10% off", "subscribe", "join our newsletter") AND footer/inline "Stay Connected" / "Sign up" / "Subscribe" email sections are NOT the booking form, even though they have input fields. NEVER fill or submit them (a real run filled a footer newsletter box). The booking form always has DATES and ROOMS/PLAYERS; any form with no dates is marketing — scroll past it.
- INQUIRY / TRIP-PLANNER FORMS: "Plan My Trip", "Request a Quote", "Trip Planner", "Request Information", "Contact Us", "Anfragen", "Richiesta" — forms that collect your details so a HUMAN can call you back are INQUIRIES, not bookings. They never show live availability or prices. Do NOT fill them as if they were the booking. Look instead for "Book"/"Reserve"/"Stay"/"Lodging"/"Rooms"/"Tee Times" paths with real DATE fields. If the venue genuinely offers ONLY an inquiry form or a phone number — no live online booking — report failed / form_not_found and quote the phone number in your message.
- CHAT WIDGETS / AI CONCIERGES / WhatsApp bubbles ("How may I help you?", suggested-question buttons like "Please check room availability"): NEVER type into them, never click their suggestion buttons — a chat is a CONVERSATION, not a booking engine, and it cannot complete a reservation. Close or ignore the chat panel and find the real BOOK button instead.

LANGUAGES: you read EVERY language fluently — never stall or slow down because a site is German/Italian/French/Spanish. Act on foreign labels exactly as you would English. Booking vocabulary you must recognize instantly:
- BOOK/RESERVE: Buchen, Reservieren (DE) · Prenota (IT) · Réserver (FR) · Reservar (ES/PT) · Boek (NL)
- AVAILABILITY/RATES: Verfügbarkeit, Preise (DE) · Disponibilità (IT) · Disponibilités, Tarifs (FR) · Disponibilidad (ES)
- CHECK-IN/OUT: Anreise/Abreise (DE) · Arrivo/Partenza (IT) · Arrivée/Départ (FR) · Llegada/Salida (ES)
- ROOMS/GUESTS/ADULTS: Zimmer/Gäste/Erwachsene (DE) · Camere/Ospiti/Adulti (IT) · Chambres/Adultes (FR) · Habitaciones/Adultos (ES)
- CONTINUE/CONFIRM: Weiter/Bestätigen (DE) · Avanti/Conferma (IT) · Continuer/Confirmer (FR) · Continuar/Confirmar (ES)
Beware "ANFRAGEN"/"Richiesta"/"Demande" = INQUIRY (an email form, not instant booking) — prefer the BUCHEN/PRENOTA/RÉSERVER instant-booking path when both exist.

STEP 0.5 — GET OFF THE HOMEPAGE FAST (the #1 time-waster is loitering here):
After clearing overlays, look ONCE at the landing view. If you can see a booking/date widget → use it. If you CANNOT see one, do NOT scroll around exploring, do NOT read the marketing page — go STRAIGHT to the menu:
1. If there's a "BOOK" / "BOOK NOW" / "RESERVE" / "CHECK AVAILABILITY" button anywhere in the header → click it NOW.
2. Otherwise open the MENU — the hamburger icon (☰, three lines) in a top corner — and click the booking entry: "BOOKING" / "BOOK" / "RESERVE" / "RATES" / "STAY" / "ROOMS" / "PRENOTA" / "RÉSERVER".
3. Splash screens (a logo + a few floating words + intro animation, no real content): same rule — click "SKIP"/"ENTER" if visible, else menu → BOOKING. Never hunt for a form on an art page.
Budget: you should be OFF the homepage and onto a booking surface within your FIRST 2-3 STEPS. Every extra homepage step is wasted clock.

CORE RULES
1. FINISH THE BOOKING. Reaching a room list / time-slot picker / checkout button is HALFWAY done, not done. Select the room/slot, fill the form, click the final submit. The only valid stops are: a real confirmation page, the payment/deposit step (see rule 6), or a listed failure.
2. ONE submission only. Never submit twice. If you submit and can't see clear confirmation, report needs_review — never resubmit (a double-booking is worse than a missed one).
3. CONFIRMED requires PROOF: a real confirmation/reservation/order number or an explicit "your reservation is confirmed" message — quote it. Submitted but no confirmation visible → needs_review.
4. NEVER invent data. Use only the traveler details in the task. If a REQUIRED field needs something you weren't given, report needs_review.
5. PRICE IS NEVER A REASON TO STOP. Default to the CHEAPEST suitable option, but if the real price runs higher than the estimate in the task, BOOK IT ANYWAY and quote the real total in your message — the customer reviewed before booking and can cancel after. Your job is to COMPLETE the reservation; judging affordability is the customer's job, not yours.
6. PAYMENT: do NOT type any card number yourself, and never make one up. Drive the booking all the way TO the card-entry step — pick the room/tee time, fill all guest/driver details, accept mandatory terms — and STOP the moment a credit-card NUMBER is required, leaving the card fields blank. Reaching that filled-in payment step is a GOOD outcome: the system takes over from there to enter payment securely. In your message, quote the exact room/tee time + total price you reached (e.g. "Standard King — $1,325 for 5 nights, at the card step").

DATES (get these right — most failures start here, especially the calendar)
- TRY TYPING FIRST. If there's a check-in / check-out TEXT field, click it and TYPE the date in the format it shows (MM/DD/YYYY, or DD/MM/YYYY on European sites) — typing is ONE action and far more reliable than clicking calendar cells. Only fall to the calendar if there's no typable field.
- CLICK FIELDS AND DAY CELLS, NEVER ICONS. Inside date widgets, aim every click at the INPUT/field itself, the visible date TEXT, or the day-number cell — never at the little calendar/chevron ICONS (svg decorations). Those icons disappear when the widget re-renders, and clicking them fails repeatedly (a real run burned 5 identical failed clicks on one svg). If a click on any calendar element errors or changes nothing, do NOT repeat it — click the field's text instead, or type the date.
- CALENDAR WIDGET — the precise sequence (this is where runs get stuck):
  1. Read the calendar's MONTH/YEAR header ONCE and COMPUTE the number of next-month clicks you need (e.g. June shown, August needed = 2 clicks). Then fire those next-arrow clicks (›, →, "Next", right chevron) BACK-TO-BACK in immediate succession — do NOT re-read the page or take a fresh look between arrow clicks. Burning a full observe step per month-advance is the #1 time sink on hotel runs (one run spent 13 steps / 2 minutes on this widget alone).
  2. Click the exact DAY NUMBER cell for check-IN (e.g. the cell labeled "17"). Pick the cell INSIDE the correct month (calendars often show two months — make sure you click the one under the right header).
  3. Click the exact DAY NUMBER cell for check-OUT.
  4. CONFIRM the date fields now show your dates. If they still show the default/today, your day-clicks didn't land — re-click the day cells.
  Done right, the WHOLE calendar (advance + both days + confirm) is 2-3 steps, not 10.
- WRONG DEFAULT DATES: many widgets pre-fill arrival = today/tomorrow (e.g. shows "Arrival Fri Jun 12 / Departure Sat Jun 13" when you need August). Dates LOOKING filled does NOT mean they're right — you MUST change them to the task's dates. Read the month header; if it's not your target month, click the next-month arrow (›/→/chevron) to advance, then click your arrival day, then your departure day, then proceed. Never click Search/Book while the dates still show the default.
- A DUAL-MONTH calendar shows two months side by side (e.g. "June 2026" and "July 2026"). To reach a later month, click the › / right arrow to slide the window forward one month per click until your target month is one of the two shown, THEN click the day cell under the CORRECT month header.
- DO NOT GET STUCK. If you've tried the SAME action ~2-3 times and the dates still aren't set (the field hasn't changed), STOP repeating it and switch tactics: try typing the date into the field instead; or click a different element (the field label vs the cell); or close the calendar and reopen it. Spinning on one stubborn calendar is the #1 way runs die — change your approach instead of repeating.
- HOTEL: set BOTH check-in AND check-out so the night count matches — never leave it at one night or "today".
- Many sites default to today's date and show "no availability" — always set the requested date FIRST, then read availability.

HOTEL PLAYBOOK
1. The booking widget is almost always RIGHT ON THE HOMEPAGE — the "Check in — Check out / Guests / Check Rates" bar in the hero. USE IT IN PLACE. Do NOT navigate off to a separate "Reservations" / "Book" page hunting for a form when one is already on screen. Only go looking for a "Book"/"Reserve"/"Check Availability" link if there is genuinely no date widget visible.
2. BATCH the search inputs: in as few turns as possible, set check-in, set check-out, set the guest/room count, THEN click Check Rates / Search. Fill the dates and guests together — don't burn one turn per field, and don't take a step just to confirm a field "took". One decisive turn of inputs, then search. GUESTS: the widget almost always DEFAULTS TO 1 ADULT — you MUST change it to the party size in the task (e.g. 2 adults for a 2-person trip). Booking the wrong headcount is a real failure; set the guest count explicitly, never leave it at the default 1.
3. Pick a room. **The room/suite name in the task is a PREFERENCE, not a requirement.** If the exact named room (e.g. "Junior Suite") isn't listed, pick the CHEAPEST available room that sleeps the party. The search returning rooms — even differently-named ones — means the hotel IS available: select one and CONTINUE. Quitting because the named room isn't listed is a failure you must never make. Don't compare every room or re-read the page — choose one and move on.
4. WHEN THE PAGE SHOWS RATES WITH "RESERVE" / "BOOK" / "SELECT" BUTTONS, YOUR ACTION IS TO CLICK ONE — on the SAME step you see the list, not a later one. Do not keep reading. Do not "pause to think". Do not scroll through all the rooms first. The first room card visible that fits the party: click its Select/Book. If multiple rate options for the same room are shown (e.g. "Best Flexible Rate" vs "Best Flexible With Breakfast"), pick the CHEAPEST and click ITS button. After clicking Select, NEVER go back to re-compare rooms — push forward to guest details. Sitting on a rate list without clicking is the same failure as quitting (a real run died at the time cap staring at a rate list it had already earned).
4a. AVAILABILITY GRID / MATRIX (rows = room types, columns = individual nights, cells full of × marks and per-night prices): do NOT try to click the per-night cells or decode the grid — that grid is just an availability calendar. Look at the RIGHT-HAND column, where each room that's bookable for the WHOLE stay shows a total price ("incl. taxes & fees") next to a "Book now" / "Book" button. IMMEDIATELY click the "Book now" of the CHEAPEST room with a bookable total. Ignore rows that say "Not available" / "Available on [date]" (those can't be booked for the full stay). One glance at the right column, pick the lowest total with a Book button, click it — do not dwell on this page, it is the single most time-consuming page in the flow.
4b. ROOM CARDS with "VIEW OFFERS" / "VIEW RATES" / "SELECT" / "CHOOSE" buttons and a "FROM $X / night" price (each room is a photo card you can scroll past): this is a room LIST, not the final rates. Do NOT scroll through every room reading descriptions, amenities (Robes, Coffee & Tea, Room Service), or photo galleries — that is wasted motion that burns the clock. Pick the CHEAPEST room and IMMEDIATELY click ITS "View Offers"/"View Rates"/"Select" button to open its rates, then pick the cheapest rate and continue to guest details. Never click "View More"/"Read more"/photo arrows. The moment you see room cards with a select/offers button, your next action is to CLICK one — not to read.
5. PRICE — pick the CHEAPEST suitable room and BOOK IT even when it costs more than the task's estimate. Quote the real total in your message (e.g. "Portonovi Room — $20,205 for 9 nights, above the $16,200 estimate"). Walking away over price is a failure; the customer approves/cancels, not you.
6. Continue to guest details, fill name/email/phone, proceed toward booking, and STOP at the payment/card step per rule 6 above (the system pays).

ACCOUNT / REGISTRATION WALLS
- PREFER GUEST CHECKOUT. Only create an account when the venue genuinely
  REQUIRES it to book (e.g. a "visitor registration" / "Inscription visiteur"
  wall with no guest option).
- When registration IS mandatory: use the traveller's email + the EXACT
  "Account password" given in the task (never invent your own), tick any
  required terms checkbox, submit the registration, then CONTINUE the booking
  flow to completion — registering is NOT the end, it's a step. Don't stop and
  report needs_review just because you registered; push on to the tee-time /
  room selection and the real confirmation.
- A login wall for an account you DON'T have credentials for (no register
  option, only "sign in"), or SMS/phone verification, → failed / login_required.

GOLF / TEE-TIME PLAYBOOK
- The booking lives under "Tee Times", "Book a Tee Time", "Golf", "Reserve", or a resort's "Experiences" / "Recreation" section — open it.
- Many courses embed a booking widget (GolfNow, Lightspeed/Chronogolf, ForeUp, TeeQuest). That widget IS the real booking system — use it, even if the URL host changes.
- Set the DATE and number of PLAYERS, then pick the tee time at or closest to the requested time. Click the slot (don't stop on the picker — clicking it opens the form), fill the player/contact details, and book. If a card/deposit is required, STOP per rule 6.

CAR-RENTAL PLAYBOOK
1. Find the rental search — pick-up location, pick-up date/time, and drop-off date/time. Set them from the task (use the city/airport in the task as the pick-up location).
2. Search, then pick a vehicle. **The car class in the task (e.g. "Luxury SUV", "Standard") is a PREFERENCE.** If that exact class isn't offered, pick the closest available vehicle that fits the party and budget — never quit because the named class isn't listed.
3. Choose "pay at counter" / "pay later" over prepaid when both exist (avoids the card step). Decline insurance, extras, and upsells unless mandatory.
4. Continue to the driver-details form, fill name/email/phone, and proceed. If a card/prepayment is required to confirm, STOP per rule 6 and quote the car + total price.

WHEN TO STOP (report honestly)
- Real confirmation visible → confirmed, number quoted.
- No availability for the requested date (after confirming the date is set correctly) → failed / no_availability.
- A captcha you can't pass → failed / captcha_blocked. Mandatory account login you don't have → failed / login_required.
- WHOLE-SITE BOT BLOCK: if the page (or the whole domain) returns "Access Denied" / a bot-detection block (Akamai / PerimeterX / Cloudflare with a reference number — common on big chains like Marriott, Hilton, the OTAs), STOP IMMEDIATELY and report failed / captcha_blocked. Do NOT reload or re-navigate repeatedly — once the edge has blocked you it will keep blocking you, and retrying just burns time. One reload to confirm is fine; after that, report it.
- Genuinely no online booking path at all (phone/email only) → failed / form_not_found — and quote the phone/email you saw.
- PRIVATE / MEMBERS-ONLY venue (the only path is a members portal needing a member number, or the site says private club / not open to the public) → failed / members_only. Say so plainly — the public can't book here at all, so a different date or a retry won't help.
- Card/deposit step reached → STOP with everything filled and the card fields BLANK (rule 6 — the system enters payment); note the room/tee time + total.
- Going in circles with no progress → needs_review describing exactly where you're stuck.

NEVER STOP SILENTLY. If you can see a Reserve/Book/Submit button that fits the task, click it. If you can't proceed for any reason — budget, missing field, broken flow, unclear UI — say WHY in your message, with the exact prices/labels you saw. "Just stopping" with no actionable message is the worst failure mode.`;

export async function runStagehandBooking(
  opts: RunStagehandOptions,
): Promise<RunStagehandResult> {
  // Use the lean DOM-native prompt, NOT the heavy vision-era goal.system
  // that run-booking passes (kept on opts.system for the computer-use
  // fallback). This is the single biggest speed + cost win.
  const system = STAGEHAND_SYSTEM;

  // Pick the browser infra. BROWSER_PROVIDER=steel runs on steel.dev (CDP
  // connection); anything else uses Browserbase. Both key sets can coexist
  // in .env.local — this just selects which one runs, so flipping back is
  // one word. Steel returns a session we must release in `finally`.
  const provider = (optionalEnv("BROWSER_PROVIDER") ?? "browserbase").toLowerCase();
  const useSteel = provider === "steel";

  let steelSession: SteelSession | null = null;
  let stagehand: Stagehand;

  if (useSteel) {
    console.log("[steel] creating session…");
    try {
      steelSession = await createSteelSession({
        solveCaptcha: opts.solveCaptchas,
        timeoutMs: opts.timeoutMs,
      });
    } catch (e) {
      // Make Steel setup failures LOUD — otherwise they vanish into the
      // booking record and the run just looks "stuck" with no [stagehand] log.
      console.error(
        `[steel] ✗ session setup FAILED: ${e instanceof Error ? e.message : e}`,
      );
      throw e;
    }
    stagehand = new Stagehand({
      env: "LOCAL",
      // Connect Stagehand to the Steel browser over CDP instead of launching
      // a local Chromium or using Browserbase. Steel's gateway authenticates
      // the websocket itself — the key must ride on the connect URL AND the
      // headers, or the upgrade bounces with a bare 502.
      localBrowserLaunchOptions: {
        cdpUrl: steelSession.connectUrl,
        cdpHeaders: { "Steel-Api-Key": steelApiKey() },
      } as never,
      model: {
        modelName: STAGEHAND_MODEL as never,
        apiKey: env("ANTHROPIC_API_KEY"),
      },
      systemPrompt: system,
      selfHeal: true,
      domSettleTimeout: 1000,
      experimental: true,
      disableAPI: true,
      verbose: 0,
    });
  } else {
    const apiKey = env("BROWSERBASE_API_KEY");
    const projectId = env("BROWSERBASE_PROJECT_ID");
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey,
      projectId,
      model: {
        modelName: STAGEHAND_MODEL as never,
        apiKey: env("ANTHROPIC_API_KEY"),
      },
      systemPrompt: system,
      // Self-healing: Stagehand re-resolves a selector if the page shifted,
      // instead of failing the action. Big reliability win on dynamic sites.
      selfHeal: true,
      // Block the agent's actions until Browserbase finishes solving any
      // captcha — so the agent doesn't try to click through a challenge.
      waitForCaptchaSolves: opts.solveCaptchas,
      // Shorter DOM-settle (default ~3s) shaves time off every step where
      // the page is already stable. 1000ms is enough for most booking
      // widgets to paint; the self-heal + per-action waits cover the rest.
      domSettleTimeout: 1000,
      // We pass agent callbacks (onStepFinish → live progress) and an abort
      // signal (our wall-clock timeout) to agent.execute(). Stagehand
      // requires experimental: true + disableAPI: true to use those — the
      // server-side Stagehand API path doesn't support them. disableAPI
      // just runs the LLM directly (no Stagehand-cloud caching), which is
      // exactly what we want: fresh session per booking, no shared cache.
      experimental: true,
      disableAPI: true,
      verbose: 0,
      browserbaseSessionCreateParams: {
        projectId,
        browserSettings: {
          viewport: {
            width: AGENT_VIEWPORT.width,
            height: AGENT_VIEWPORT.height,
          },
          ...(opts.solveCaptchas ? { solveCaptchas: true } : {}),
          ...(opts.advancedStealth ? { advancedStealth: true } : {}),
        },
        ...(opts.solveCaptchas ? { proxies: true } : {}),
        region: opts.region ?? DEFAULT_REGION,
        timeout: Math.ceil(opts.timeoutMs / 1000) + 60,
      } as never,
    });
  }

  // Hard wall-clock — abort the agent if it runs long.
  const controller = new AbortController();
  const wallClock = setTimeout(() => controller.abort(), opts.timeoutMs);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  try {
    console.log(
      `[stagehand] init… provider=${provider} model=${STAGEHAND_MODEL} region=${opts.region ?? DEFAULT_REGION} captcha=${opts.solveCaptchas} stealth=${opts.advancedStealth}`,
    );
    await stagehand.init();
    const sessionUrl =
      steelSession?.viewerUrl ?? stagehand.browserbaseSessionURL ?? null;
    console.log(`[stagehand] ✓ session ready (${elapsed()}) ${sessionUrl ?? ""}`);

    // Navigate the page the AGENT will actually drive. The agent operates on
    // the context's ACTIVE page — not necessarily pages()[0]. On Browserbase
    // those are the same, but when we attach over raw CDP (Steel), the browser
    // already has an about:blank tab: pages()[0] is that blank tab while the
    // agent's active page is a different one, so navigating pages()[0] left the
    // agent stranded on about:blank. Use activePage(), create one if the CDP
    // browser exposed none yet, and pin it active so navigation + agent agree.
    let page = stagehand.context.activePage() ?? stagehand.context.pages()[0];
    if (!page) {
      page = await stagehand.context.newPage();
    }
    if (!page) {
      throw new Error(
        `Stagehand init returned no page — the ${provider} session never opened a tab.`,
      );
    }
    stagehand.context.setActivePage(page);
    // SPEED: drop heavy third-party junk (analytics, ad/marketing tags,
    // session-replay, autoplay video) at the network layer BEFORE the first
    // navigation. The DOM agent reads the accessibility tree, not pixels, so
    // none of this is needed — but on luxury-hotel sites it's often the bulk
    // of what a page waits on, so blocking it shaves seconds off every page
    // load AND every domSettle. Deliberately tracker/media-only: CSS, images,
    // fonts, and captcha/recaptcha/turnstile are left untouched so layout,
    // confirmation reads, and the captcha-solver all keep working.
    await blockHeavyResources(page);

    await opts.onStep?.(`Opening ${shortHost(opts.startUrl)}…`);
    await page.goto(opts.startUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });
    console.log(`[stagehand] ✓ navigated to ${opts.startUrl} (${elapsed()})`);

    // Pre-clear cookie / consent overlays BEFORE handing off to the agent.
    // These banners sit on top of the page and intercept every click — the
    // #1 cause of a run stalling (Carson watched the agent sit on Finca
    // Cortesin's "This website uses cookies" modal the whole run). One
    // cheap up-front act() dismisses it deterministically so the agent
    // starts on a clear page. Best-effort: no banner ⇒ fast no-op; any
    // error is swallowed (STEP 0 in the system prompt is the backstop).
    try {
      await opts.onStep?.("Clearing cookie banner…");
      // FAST PATH: a deterministic in-page DOM pass clicks the accept button
      // of the common consent managers (OneTrust, Cookiebot, Didomi,
      // Usercentrics…) and any button whose visible label reads
      // Accept/Agree/OK in 7 languages. One CDP round-trip, no LLM call —
      // this is the case that used to cost a full ~5-10s act() on EVERY run.
      const cleared = await dismissConsentDeterministically(page);
      if (cleared) {
        console.log(
          `[stagehand] ✓ consent dismissed deterministically ("${cleared}") (${elapsed()})`,
        );
      } else {
        // No standard banner matched. Do NOT spend an unbounded LLM act()
        // here — on heavy sites (Four Seasons Bosphorus) that call ballooned
        // to ~105s because it isn't covered by the agent's toolTimeout and it
        // re-reads the entire bloated page. The agent's STEP 0 clears any
        // non-standard banner as its very first action instead, and THAT is
        // bounded by the 25s per-action timeout. One bounded agent step beats
        // a 100-second pre-clear hang every time.
        console.log(
          `[stagehand] no standard consent banner matched — deferring to agent STEP 0 (${elapsed()})`,
        );
      }
    } catch (e) {
      console.warn(
        `[stagehand] consent pre-clear skipped: ${e instanceof Error ? e.message : e}`,
      );
    }

    // DOM-mode agent: act / fillForm / extract / goto via the page's
    // accessibility tree — no screenshots, no coordinate guessing.
    //
    // SPEED via split models (NOT downgrading the brain):
    //   model          = Sonnet — high-level planning ("now set the
    //                    party size, then the time, then submit"). This
    //                    is the part Haiku couldn't do.
    //   executionModel = Haiku — the per-action observe/act tool calls
    //                    ("find the date field", "click 7:30 PM"). These
    //                    are the BULK of the calls and don't need
    //                    reasoning, so Haiku runs them ~3x faster/cheaper
    //                    while Sonnet stays in charge of the plan.
    const agent = stagehand.agent({
      mode: "dom",
      model: STAGEHAND_MODEL,
      executionModel:
        optionalEnv("STAGEHAND_EXECUTION_MODEL") ?? "anthropic/claude-haiku-4-5",
      systemPrompt: system,
    });

    const maxSteps = opts.maxSteps ?? MAX_STEPS;
    console.log(
      `[stagehand] agent.execute starting (maxSteps=${maxSteps}, toolTimeout=${TOOL_TIMEOUT_MS}ms)…`,
    );
    let stepCount = 0;
    const result = await agent.execute({
      instruction: opts.task,
      maxSteps,
      // Cap each individual tool call so a hung action recovers fast instead
      // of eating 45s of the wall-clock budget (see TOOL_TIMEOUT_MS above).
      toolTimeout: TOOL_TIMEOUT_MS,
      // DOM mode reads the accessibility tree to act — it never NEEDS a
      // screenshot. But the agent still reaches for the screenshot tool, and
      // on pages with a looping background video (Four Seasons) that capture
      // never settles and burns a full toolTimeout per call. We don't use the
      // agent's screenshot for the final proof anyway (the Stagehand path
      // returns finalScreenshot:null), so take the tool away — it forces the
      // agent onto the DOM tree, which is what makes DOM mode fast.
      excludeTools: ["screenshot"],
      signal: controller.signal,
      callbacks: {
        onStepFinish: async () => {
          stepCount += 1;
          console.log(`[stagehand]   step ${stepCount} done (${elapsed()})`);
          await opts.onStep?.(progressLabel(stepCount));
        },
      },
    });
    console.log(
      `[stagehand] ✓ agent finished (${elapsed()}) success=${result.success} completed=${result.completed} steps=${result.actions?.length ?? stepCount}\n  agent message: ${result.message?.slice(0, 600) || "(no message)"}`,
    );
    // Loud flag when the agent stops without saying anything useful — that's
    // the "just stopped" case and we want it screaming in the terminal so we
    // can see it instead of a quiet needs_review later.
    if ((result.message ?? "").trim().length < 40) {
      console.warn(
        `[stagehand] ⚠ thin/empty agent message — likely a silent stop. steps=${stepCount}, last progress label may indicate where.`,
      );
    }

    // If the agent crashed internally (Stagehand surfaces these as
    // success=false with the error in result.message rather than
    // throwing), DON'T waste an extract() call — the session is usually
    // dead. Classify and return immediately so the retry loop / UI gets
    // an honest reason instead of a misleading needs_review.
    const agentMsg = result.message ?? "";
    if (result.success === false) {
      if (/credit balance is too low|insufficient.*credit|quota/i.test(agentMsg)) {
        console.error("[stagehand] ✗ Anthropic credits exhausted mid-booking.");
        return {
          outcome: {
            status: "failed",
            failureReason: "ambiguous",
            message:
              "Booking stopped — the AI account ran out of credits. Top up Anthropic billing and try again.",
          },
          sessionUrl,
          finalScreenshot: null,
        };
      }
      if (
        /awaitActivePage|Cannot read properties of null|transport closed|socket-close|CDP/i.test(
          agentMsg,
        )
      ) {
        console.error(`[stagehand] ✗ session crashed mid-run: ${agentMsg.slice(0, 160)}`);
        return {
          outcome: {
            status: "failed",
            // ambiguous IS retryable — a fresh session usually recovers
            // from a CDP/transport drop.
            failureReason: "ambiguous",
            message:
              "The booking session dropped before finishing — retrying on a fresh session.",
          },
          sessionUrl,
          finalScreenshot: null,
        };
      }
    }

    // ── PAYMENT PHASE ────────────────────────────────────────────────────
    // If a card provider is wired AND the agent didn't already crash or
    // confirm, check whether it stopped at a card-entry step. If so, charge
    // the customer + mint a single-use virtual card (cardProvider) and type
    // it in to finish. The PAN is fetched here, used once, and never logged
    // or persisted; the single-use card + the <2s auth webhook bound the
    // blast radius to exactly this one charge.
    const agentAlreadyConfirmed = /confirm(ed|ation)|reservation (#|number|id)/i.test(
      agentMsg,
    );
    if (
      opts.cardProvider &&
      result.success !== false &&
      !agentAlreadyConfirmed
    ) {
      const pay = await detectPaymentStep(stagehand).catch(() => ({
        atPayment: false,
        amountCents: null,
        currency: null,
      }));
      if (pay.atPayment) {
        console.log(
          `[stagehand] payment step detected (${elapsed()}) — total=${pay.amountCents != null ? `${pay.amountCents}c ${pay.currency ?? ""}` : "unknown"} — charging + paying`,
        );
        await opts.onStep?.("Securing payment…");
        const card = await opts.cardProvider(pay.amountCents);
        if (card.status !== "ok") {
          // Couldn't charge / no saved card / Stripe off → stop cleanly at
          // payment. NEVER enter a card we don't have. Customer not charged.
          console.warn(`[stagehand] card provider unavailable: ${card.reason}`);
          return {
            outcome: {
              status: "needs_review",
              message:
                "Everything's filled in and ready to pay — we paused at the payment step. " +
                card.reason.replace(/\s*(Stop entering payment and )?call report_outcome[^.]*\.?/gi, "").trim(),
            },
            sessionUrl,
            finalScreenshot: null,
          };
        }
        // Card in hand. Type it and submit. Scoped instruction — the PAN
        // appears only in THIS execute call, not the booking-navigation
        // context, and we deliberately do NOT log the result message.
        await opts.onStep?.("Completing payment…");
        try {
          await agent.execute({
            instruction: cardEntryInstruction(card),
            maxSteps: 14,
            signal: controller.signal,
            callbacks: {
              onStepFinish: async () => {
                await opts.onStep?.("Completing payment…");
              },
            },
          });
          console.log(`[stagehand] ✓ payment submitted (${elapsed()})`);
        } catch (payErr) {
          // Customer is already charged (cardProvider charged before we
          // typed). The funded single-use card lets a human finish, so
          // surface needs_review, NOT a failure — never imply we lost money.
          console.error(
            `[stagehand] payment-entry error (${elapsed()}): ${payErr instanceof Error ? payErr.message : payErr}`,
          );
          return {
            outcome: {
              status: "needs_review",
              message:
                "We secured your payment but hit a snag entering it on the venue's checkout — Pyltrix is finishing this booking manually and will confirm shortly.",
            },
            sessionUrl,
            finalScreenshot: null,
          };
        }
        // Fall through to the proof extract below — it reads the
        // confirmation off the post-payment page.
      }
    }

    // Pull the structured outcome from the FINAL page. This is the proof
    // gate — the agent's own claim of success is not trusted; we read the
    // confirmation off the page ourselves.
    //
    // FAST PATH: when the agent has already CLAIMED a failure or NEEDS_REVIEW
    // in its own message, skip the extract() — saves ~10s + a Haiku call.
    // The agent's natural-language message is honest about its own state; we
    // only need to RE-VERIFY when it claims success (the skeptical gate).
    const agentClaimsConfirmed = /confirm(ed|ation)|reservation (#|number|id)/i.test(
      agentMsg,
    );
    let extracted: z.infer<typeof stagehandOutcomeSchema>;
    if (result.success === false && !agentClaimsConfirmed) {
      console.log(
        "[stagehand] skipping extract() — agent already reported non-success, trusting its message.",
      );
      extracted = {
        status: classifyFromAgentMessage(agentMsg),
        confirmationCode: null,
        confirmationEvidence: null,
        amountChargedCents: null,
        failureReason: reasonFromAgentMessage(agentMsg) ?? null,
        message: agentMsg.slice(0, 240) || "Booking did not complete.",
      };
    } else {
      await opts.onStep?.("Verifying the confirmation…");
      try {
        extracted = await stagehand.extract(
          "Extract the booking outcome from the current page. Look for a confirmation/reservation number, an explicit confirmation message, and any amount charged. If the page is not a confirmation page, status is needs_review.",
          stagehandOutcomeSchema,
        );
      } catch (exErr) {
        console.warn(
          `[stagehand] extract() failed (${elapsed()}): ${exErr instanceof Error ? exErr.message : exErr}`,
        );
        extracted = {
          status: "needs_review",
          confirmationCode: null,
          confirmationEvidence: null,
          amountChargedCents: null,
          failureReason: null,
          message: "Couldn't read a confirmation from the final page.",
        };
      }
    }
    console.log(
      `[stagehand] outcome: status=${extracted.status} code=${extracted.confirmationCode ?? "—"} reason=${extracted.failureReason ?? "—"} :: ${extracted.message}`,
    );

    // If the agent itself said it did NOT complete and the page shows no
    // confirmation, prefer the agent's own explanation in the message —
    // it usually says exactly what blocked it.
    const message =
      extracted.status !== "confirmed" &&
      result.completed === false &&
      result.message
        ? result.message.slice(0, 240)
        : extracted.message;

    // Capture the final page as the customer's proof. We're sitting on the
    // post-booking page right now (the extract just read it), so this is the
    // confirmation screen for a success, or wherever it stopped for a
    // needs_review. Best-effort + bounded — a video-heavy page can stall the
    // capture, and proof is a nice-to-have, never worth failing the booking.
    //
    // CAPTURE THE ACTIVE TAB, NOT pages[0]. Venues routinely open their
    // booking engine in a NEW tab ("Book Online" → third-party engine), so
    // the confirmation lives on the LAST-opened page, not the original
    // homepage tab. Grab the freshest page (matches what extract() read).
    const proofPage = stagehand.context.pages().at(-1) ?? page;
    const finalScreenshot =
      extracted.status === "confirmed" || extracted.status === "needs_review"
        ? await captureProofScreenshot(proofPage)
        : null;

    return {
      outcome: {
        status: extracted.status,
        confirmationCode: extracted.confirmationCode,
        confirmationEvidence: extracted.confirmationEvidence,
        amountChargedCents: extracted.amountChargedCents,
        failureReason: extracted.failureReason ?? undefined,
        message,
      },
      sessionUrl,
      finalScreenshot,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(msg));
    // Loud, tagged, one-line root cause — so the dev terminal shows
    // exactly why the agent stopped instead of a silent black screen.
    console.error(`[stagehand] ✗ FAILED (${elapsed()}) — ${msg}`);
    return {
      outcome: {
        status: "failed",
        failureReason: aborted ? "timeout" : "ambiguous",
        message: msg,
      },
      sessionUrl: null,
      finalScreenshot: null,
    };
  } finally {
    clearTimeout(wallClock);
    await stagehand.close().catch(() => {});
    // Steel sessions persist until released or they hit their timeout — free
    // it now so we're not paying for an idle browser.
    if (steelSession) await releaseSteelSession(steelSession.id).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Steel.dev session lifecycle (used when BROWSER_PROVIDER=steel)              */
/* -------------------------------------------------------------------------- */

type SteelSession = {
  id: string;
  /** CDP websocket URL Stagehand connects to. */
  connectUrl: string;
  /** Human-viewable live session URL (for logs / debugging). */
  viewerUrl: string | null;
};

const STEEL_API_BASE = "https://api.steel.dev/v1";

/** The Steel key, tolerant of quotes/whitespace pasted into .env.local. */
function steelApiKey(): string {
  return env("STEEL_API_KEY").trim().replace(/^["']|["']$/g, "");
}

/**
 * Create a Steel browser session and return the CDP connect URL Stagehand
 * attaches to. Throws a tagged error (with Steel's own message) on failure so
 * a misconfig surfaces loudly instead of silently falling back. Mirrors the
 * Browserbase session settings we use (viewport, captcha, proxy, timeout).
 */
async function createSteelSession(args: {
  solveCaptcha: boolean;
  timeoutMs: number;
}): Promise<SteelSession> {
  // Defensively strip surrounding quotes/whitespace — a key pasted as
  // STEEL_API_KEY="ste-…" should still authenticate.
  const key = env("STEEL_API_KEY").trim().replace(/^["']|["']$/g, "");
  // Don't let a hung Steel API call stall the whole booking silently.
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${STEEL_API_BASE}/sessions`, {
      method: "POST",
      headers: {
        "Steel-Api-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Minimal, safe body — let Steel default everything else. Extra
        // fields (solveCaptcha/useProxy) were the likely 400 cause; we're
        // testing speed here, not captcha, so keep the request lean.
        timeout: Math.min(Math.max(args.timeoutMs + 60_000, 60_000), 900_000),
        dimensions: { width: AGENT_VIEWPORT.width, height: AGENT_VIEWPORT.height },
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      `[steel] create session request failed: ${e instanceof Error ? e.message : e} (check STEEL_API_KEY + network)`,
    );
  } finally {
    clearTimeout(killer);
  }
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // Surface Steel's FULL complaint — NestJS-style 400s put the useful
    // detail in `message` (often an array of field errors), while `error`
    // is just the generic "Bad Request" label. Always include the raw body
    // so nothing is hidden.
    const detail = Array.isArray(json.message)
      ? json.message.join("; ")
      : typeof json.message === "string"
        ? json.message
        : typeof json.error === "string"
          ? json.error
          : "";
    throw new Error(
      `[steel] create session → ${res.status}: ${detail || "(no message)"} | raw=${text.slice(0, 400)}`,
    );
  }
  const id = String(json.id ?? json.sessionId ?? "");
  if (!id) throw new Error("[steel] create session returned no id");
  // Steel's documented external-automation connect URL. Prefer an explicit
  // websocket/connect field if the API returns one; otherwise build it.
  let connectUrl =
    (json.websocketUrl as string) ||
    (json.connectUrl as string) ||
    `wss://connect.steel.dev?sessionId=${id}`;
  // Steel's gateway authenticates the websocket UPGRADE itself: without the
  // apiKey on the URL the connection dies as a bare "Unexpected server
  // response: 502". The websocketUrl Steel returns does NOT include the key,
  // so append it whenever it's missing.
  if (!/[?&]apiKey=/i.test(connectUrl)) {
    connectUrl +=
      (connectUrl.includes("?") ? "&" : "?") +
      `apiKey=${encodeURIComponent(key)}`;
  }
  const viewerUrl =
    (json.sessionViewerUrl as string) ?? (json.debugUrl as string) ?? null;
  console.log(
    `[steel] ✓ session ${id} created ${viewerUrl ?? ""} (cdp: ${connectUrl.replace(/apiKey=[^&]+/i, "apiKey=[KEY]")})`,
  );
  return { id, connectUrl, viewerUrl };
}

/** Release a Steel session so we stop paying for an idle browser. */
async function releaseSteelSession(id: string): Promise<void> {
  const key = optionalEnv("STEEL_API_KEY");
  if (!key) return;
  await fetch(`${STEEL_API_BASE}/sessions/${encodeURIComponent(id)}/release`, {
    method: "POST",
    headers: { "Steel-Api-Key": key },
  });
}

/**
 * Is the browser sitting at a card-entry / payment step, and if so what's
 * the total being charged? One cheap extract read of the current page. The
 * total is the source of truth for what we charge (most items carry no
 * upfront price). Fails closed (atPayment=false) — we only ever ENTER a
 * card when we're confident it's the real checkout, never speculatively.
 */
async function detectPaymentStep(
  stagehand: Stagehand,
): Promise<{ atPayment: boolean; amountCents: number | null; currency: string | null }> {
  const schema = z.object({
    atPaymentStep: z
      .boolean()
      .describe(
        "true ONLY if the current page is asking for a credit/debit CARD NUMBER to complete this booking (a card-number field, or a 'Payment'/'Pay'/'Checkout' step with card inputs). false for room lists, guest-detail forms, confirmation pages, or anything without a card field.",
      ),
    totalAmount: z
      .number()
      .nullable()
      .describe(
        "The TOTAL amount that will be charged, in major currency units (e.g. 1325.00 for $1,325). The grand total / amount due, not a per-night rate. null if not clearly shown.",
      ),
    currency: z
      .string()
      .nullable()
      .describe("3-letter currency code of the total (USD, EUR, GBP, …) if shown, else null."),
  });
  const res = await stagehand.extract(
    "Determine whether the current page is the payment / card-entry step that needs a credit card number to finish the booking, and read the grand total to be charged.",
    schema,
  );
  const amountCents =
    res?.totalAmount != null && Number.isFinite(res.totalAmount) && res.totalAmount > 0
      ? Math.round(res.totalAmount * 100)
      : null;
  return {
    atPayment: Boolean(res?.atPaymentStep),
    amountCents,
    currency: res?.currency ?? null,
  };
}

/**
 * Scoped instruction that hands the agent the single-use virtual card to
 * type. Kept terse and used in exactly one execute() call so the PAN never
 * enters the long booking-navigation context. The billing ZIP matches the
 * Issuing cardholder's billing address (94105) so AVS checks pass.
 */
function cardEntryInstruction(card: {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  cardholderName?: string;
}): string {
  const mm = String(card.expMonth).padStart(2, "0");
  const yy2 = String(card.expYear).slice(-2);
  const name = card.cardholderName ?? "Pyltrix Traveler";
  return [
    "You are on the payment step. Enter this card to complete the booking, then submit ONCE.",
    `- Card number: ${card.number}`,
    `- Expiry: ${mm}/${yy2} (or ${mm}/${card.expYear} if a 4-digit year is required)`,
    `- CVC / security code: ${card.cvc}`,
    `- Name on card: ${name}`,
    "- If a billing ZIP/postal code is required, use 94105. If billing address is required, use 1 Market St, San Francisco, CA 94105, US.",
    "Fill the card fields with EXACTLY these values (card-number fields are often inside a small frame — click into the field first, then type). Tick any mandatory terms checkbox. Then click the final Pay / Confirm / Complete Booking button exactly ONCE and wait for the page to change. Do NOT click pay twice.",
  ].join("\n");
}

/**
 * Minimal structural view of the Stagehand v3 "understudy" page — just the
 * two primitives we use here. Avoids importing Stagehand's internal Page type
 * (it isn't part of the public surface) while staying type-checked.
 */
type CdpPage = {
  evaluate<R = unknown>(
    fn: string | ((arg: unknown) => R | Promise<R>),
    arg?: unknown,
  ): Promise<R>;
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;
};

/**
 * URL globs for third-party junk the DOM agent never needs. Tracker / ad /
 * analytics / session-replay hosts plus raw video — NOT fonts, CSS, images,
 * or anything on google's recaptcha / gstatic / cloudflare-challenge paths
 * (so captcha solving and on-page confirmation reads are unaffected).
 * Matched by CDP `Network.setBlockedURLs` (supports `*` wildcards).
 */
const HEAVY_RESOURCE_BLOCKLIST = [
  "*googletagmanager.com*",
  "*google-analytics.com*",
  "*analytics.google.com*",
  "*g.doubleclick.net*",
  "*googlesyndication.com*",
  "*googleadservices.com*",
  "*adservice.google.*",
  "*connect.facebook.net*",
  "*facebook.com/tr*",
  "*hotjar.com*",
  "*hotjar.io*",
  "*static.hotjar.com*",
  "*fullstory.com*",
  "*clarity.ms*",
  "*segment.io*",
  "*cdn.segment.com*",
  "*mixpanel.com*",
  "*amplitude.com*",
  "*intercom.io*",
  "*intercomcdn.com*",
  "*hs-scripts.com*",
  "*hs-analytics.net*",
  "*bat.bing.com*",
  "*snap.licdn.com*",
  "*analytics.tiktok.com*",
  "*sentry.io*",
  "*px.ads.linkedin.com*",
  "*ct.pinterest.com*",
  "*static.ads-twitter.com*",
  "*analytics.twitter.com*",
  "*scorecardresearch.com*",
  "*quantserve.com*",
  "*chartbeat.com*",
  "*nr-data.net*",
  "*js-agent.newrelic.com*",
  "*cdn.optimizely.com*",
  "*qualtrics.com*",
  "*dynamicyield.com*",
  // Live-chat / support widgets — heavy bundles the agent never touches.
  "*widget.intercom.io*",
  "*js.driftt.com*",
  "*static.zdassets.com*",
  "*embed.tawk.to*",
  "*cdn.livechatinc.com*",
  "*client.crisp.chat*",
  // Raw video + embedded players (hero reels, virtual tours). Pure weight.
  "*.mp4*",
  "*.webm*",
  "*.m4v*",
  "*.mov*",
  "*player.vimeo.com*",
  "*youtube.com/embed*",
  "*i.ytimg.com*",
  // Web fonts — the DOM agent reads the accessibility tree's text, never the
  // rendered glyphs, so blocking these only swaps in system fonts (instant)
  // with ZERO functional impact. recaptcha/gstatic serve JS+images, not
  // woff, so captcha solving is unaffected.
  "*.woff*",
  "*.ttf",
  "*.otf",
  "*.eot",
];

/**
 * Images — blocked by DEFAULT (the single biggest page-load win on photo-heavy
 * luxury-hotel sites; the DOM agent reads text/structure, not pixels, so the
 * photos are pure dead weight). Carson's call (June 2026): prioritize speed.
 * The only cost is cosmetic — the final "Booked ✓" confirmation screenshot
 * renders with broken image placeholders, but the confirmation number, dates,
 * and price all still show clearly, and those are the real proof. Set
 * BROWSER_AGENT_BLOCK_IMAGES=false to restore a pristine screenshot.
 */
const IMAGE_BLOCKLIST = [
  "*.jpg*",
  "*.jpeg*",
  "*.png*",
  "*.gif*",
  "*.webp*",
  "*.avif*",
  "*.svg*",
];

/**
 * Block heavy third-party resources for the whole run via CDP. Best-effort:
 * if the page doesn't expose CDP or the command fails, we just skip it — the
 * booking still works, only a touch slower. Set BROWSER_AGENT_BLOCK_HEAVY
 * =false to disable entirely.
 */
async function blockHeavyResources(page: unknown): Promise<void> {
  if (optionalEnv("BROWSER_AGENT_BLOCK_HEAVY") === "false") return;
  const cdp = page as CdpPage;
  if (typeof cdp?.sendCDP !== "function") return;
  // Images blocked by default for speed; opt OUT with =false (see IMAGE_BLOCKLIST).
  const urls =
    optionalEnv("BROWSER_AGENT_BLOCK_IMAGES") === "false"
      ? HEAVY_RESOURCE_BLOCKLIST
      : [...HEAVY_RESOURCE_BLOCKLIST, ...IMAGE_BLOCKLIST];
  try {
    await cdp.sendCDP("Network.enable");
    await cdp.sendCDP("Network.setBlockedURLs", { urls });
  } catch (e) {
    console.warn(
      `[stagehand] heavy-resource block skipped: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Capture the current page as a base64 PNG — the customer's booking proof.
 * Uses CDP Page.captureScreenshot (no Playwright screenshot dependency),
 * bounded by a wall-clock so a never-settling page (looping hero video)
 * can't hang the capture. Best-effort: returns null on any failure or
 * timeout — proof is a bonus, never worth failing or stalling the booking.
 */
async function captureProofScreenshot(
  page: unknown,
  timeoutMs = 8000,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.sendCDP !== "function") return null;
  try {
    const shot = await Promise.race([
      cdp.sendCDP<{ data?: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return shot?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Deterministically dismiss a cookie / consent / privacy banner by clicking
 * the accept control in-page — no LLM call. Tries the well-known consent
 * managers by selector first, then any visible button/link whose short label
 * reads Accept / Agree / OK / Allow in EN, IT, ES, FR, DE, or PT. Returns the
 * label/selector it clicked, or null if it found nothing to dismiss (caller
 * then falls back to the LLM act()). Best-effort — never throws.
 */
async function dismissConsentDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const ACCEPT =
        /^(accept all|accept cookies|accept|agree|i agree|allow all|allow cookies|got it|ok|okay|continue|enable all|accetta tutti|accetta|acconsento|accetto|aceptar todo|aceptar|de acuerdo|tout accepter|j.accepte|accepter|alle akzeptieren|akzeptieren|zustimmen|einverstanden|aceitar tudo|aceitar|concordo)$/i;
      const KNOWN = [
        "#onetrust-accept-btn-handler",
        "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        "#CybotCookiebotDialogBodyButtonAccept",
        "#didomi-notice-agree-button",
        "button[data-testid='uc-accept-all-button']",
        "#accept-recommended-btn-handler",
        ".cc-allow",
        ".cookie-accept",
        "#cookie-accept",
        "button[aria-label='Accept all']",
        "button[aria-label='Accept all cookies']",
      ];
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rects = (el as HTMLElement).getClientRects();
        if (!rects || rects.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return (
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          Number(s.opacity || "1") > 0.05
        );
      };
      for (const sel of KNOWN) {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          (el as HTMLElement).click();
          return sel;
        }
      }
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, [role=button], a, input[type=button], input[type=submit]",
        ),
      );
      for (const el of nodes) {
        const raw =
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          "";
        const txt = raw.trim();
        if (!txt || txt.length > 40) continue;
        if (ACCEPT.test(txt) && isVisible(el)) {
          el.click();
          return txt;
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

function progressLabel(step: number): string {
  if (step <= 1) return "Finding the booking form…";
  if (step <= 3) return "Filling your reservation details…";
  if (step <= 6) return "Working through the booking…";
  return "Finishing up…";
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Map the agent's free-text "what happened" message to our schema's
 *  status enum. Used on the fast path when we skip the extract() call. */
function classifyFromAgentMessage(
  msg: string,
): "confirmed" | "failed" | "needs_review" {
  const m = (msg ?? "").toLowerCase();
  if (/no (rooms?|availability|times?|slots?)|sold out|fully booked|unavailable/i.test(m))
    return "failed";
  // Over budget is a CLEAN failure, not "needs review" — the agent did its
  // job (navigated, read real prices, refused to overspend). The customer
  // gets the honest "over your budget" message with the price quoted.
  if (/budget (rule|ceiling|exceeded)|over (the |your )?budget|exceeds? (the )?budget|above (the |your )?budget/i.test(m))
    return "failed";
  if (/members?[- ]?only|private (members'?|club)|member(ship)? (number|required|portal)|not open to the public/i.test(m))
    return "failed";
  if (/captcha|are you (a )?human|bot detection|cloudflare/i.test(m))
    return "failed";
  if (/must (sign in|log in)|account required|login required/i.test(m))
    return "failed";
  if (/card (required|needed)|deposit|prepay|payment required/i.test(m))
    return "needs_review";
  if (/no (online booking|reservation system|booking form)|phone[- ]?only/i.test(m))
    return "failed";
  return "needs_review";
}

function reasonFromAgentMessage(
  msg: string,
):
  | "no_availability"
  | "members_only"
  | "captcha_blocked"
  | "login_required"
  | "form_not_found"
  | "budget_exceeded"
  | "ambiguous"
  | undefined {
  const m = (msg ?? "").toLowerCase();
  if (/no (rooms?|availability|times?|slots?)|sold out|fully booked|unavailable/i.test(m))
    return "no_availability";
  if (/budget (rule|ceiling|exceeded)|over (the |your )?budget|exceeds? (the )?budget|above (the |your )?budget/i.test(m))
    return "budget_exceeded";
  if (/members?[- ]?only|private (members'?|club)|member(ship)? (number|required|portal)|not open to the public/i.test(m))
    return "members_only";
  if (/captcha|are you (a )?human|bot detection|cloudflare/i.test(m))
    return "captcha_blocked";
  if (/must (sign in|log in)|account required|login required/i.test(m))
    return "login_required";
  if (/no (online booking|reservation system|booking form)|phone[- ]?only/i.test(m))
    return "form_not_found";
  return "ambiguous";
}
