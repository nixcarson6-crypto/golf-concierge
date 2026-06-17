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
// 20s: Marriott-class pages kept aborting actions at 15s ("act() timed out
// ... may continue executing in the background") and re-doing them — four
// such aborts cost a run ~60s. 20s lands the slow-but-fine actions while
// still bounding genuinely hung ones.
const TOOL_TIMEOUT_MS = Number(optionalEnv("STAGEHAND_TOOL_TIMEOUT_MS")) || 20_000;

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
      "enquiry_sent",
      "ambiguous",
      "timeout",
    ])
    .nullable()
    .describe("The specific reason when not confirmed (failed, or needs_review for enquiry_sent). null otherwise."),
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
  /** The task's check-in / check-out as ISO YYYY-MM-DD — lets the
   *  deterministic date-setter click the exact calendar cells without the
   *  agent reading a heavy price-grid calendar. null for non-stay bookings. */
  checkinISO?: string | null;
  checkoutISO?: string | null;
  /** Golf only: when true, a zero-LLM pass clicks the tee-time SLOT nearest
   *  `teeTimeLabel` (or the earliest available) the moment the slot list
   *  renders — the booking widgets (ForeUp/Chronogolf) show a list of times
   *  and the agent's job is just to click one. Skipping the LLM here removes
   *  the #1 golf stall (sitting on a full slot list). */
  selectTeeSlot?: boolean;
  /** The requested tee time, any human format ("6:00 PM", "18:00") — used to
   *  pick the nearest slot. null → pick the earliest available. */
  teeTimeLabel?: string | null;
  /** Hotels only: when true, a zero-LLM pass clicks the cheapest ROOM card's
   *  CTA the moment a rooms/suites list renders — the agent's #1 hotel stall
   *  was sitting on the room grid. */
  selectRoom?: boolean;
  /** Cars only: when true, the SAME cheapest-priced-card picker + add-on/
   *  upsell skip used for hotels also runs on a rental flow — picks the
   *  cheapest vehicle the moment results render and continues past the
   *  protection/extras page (the #1 car-rental time sink) in one click. */
  selectVehicle?: boolean;
  /** Price-approval gate (cents): when the venue's real total at the card
   *  step exceeds this, do NOT pay — return a price_approval outcome so the
   *  customer can approve the real price first. null = no gate (customer
   *  already approved, or no estimate exists / $25k+ budget). */
  priceGateCents?: number | null;
  /** Known traveler values for the deterministic guest-form autofill (zero
   *  LLM — runs after every step; fills recognised empty fields instantly). */
  autofill?: {
    firstName: string;
    lastName: string;
    email: string;
    /** Full E.164 ("+19038206837"). */
    phone: string;
    /** National digits ("9038206837") for fields with a country selector. */
    phoneNational: string;
    title: "Mr." | "Ms.";
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    postal?: string | null;
    /** Country display name, e.g. "United States". */
    countryName?: string | null;
  } | null;
  /** Live progress callback → wire to updateProgress for the UI. */
  onStep?: (label: string) => void | Promise<void>;
  /** Fired ONCE the browser session opens, with its live-view URL — lets the
   *  app show a "Watch live" link the instant the booking starts (the live
   *  view 404s once the session ends, so it must be surfaced early). */
  onSessionReady?: (sessionUrl: string | null) => void | Promise<void>;
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

OPERATING LOOP (follow every run):
1. PLAN ONCE. Read the page's accessibility tree ONCE on arrival and identify the full step sequence + every required field for THIS site. Every form is different — don't assume a fixed click order from memory; discover the real flow once, then execute it.
2. BATCH ACTIONS. Fill MULTIPLE fields per turn. Do NOT re-observe the page after every single action — only re-read after a navigation, a step change, or an explicit error.
3. VERIFY BY EXCEPTION. Assume your actions succeeded. Re-check a field ONLY if the next step depends on it OR a visible validation error points at it. Touch each field once; never re-open a picker or re-type a value that's already correct.
4. ADVANCE IMMEDIATELY. The moment a step's required fields are set, move to the next step. Inventory often soft-locks when you start checkout (hotel rooms, golf tee times) — once you've triggered a hold, keep moving or it expires and you lose the slot.
Ignore urgency/scarcity banners ("only 2 left", "5 people viewing") — they never change what you fill.

DEFINITION OF DONE (the agent's success = reaching the FILLED card step, since our system pays). Before you report you've reached payment, ALL must be true:
- Every required field has a value matching the task (dates/times, location, party/players/guests/room/vehicle class)
- The correct rate/option is selected (the requested policy, not blindly the cheapest default)
- No optional add-on/upsell was accepted unless the task asked for it
- No validation error is visible
If any box is unmet, fix it before stopping; if you genuinely can't, report exactly which field and why.

SPEED DOCTRINE (applies identically to HOTELS, GOLF, and CARS) — be a FAST machine, not a careful reader. The ONLY step that deserves real thought is the CARD step. Everything before it is reflex:
  Book/Reserve/"Plan My Stay" button → click instantly. Dates + party → you already KNOW them, set them in one go without surveying. Room/slot/car + guest details → you already HAVE the customer's info; fill and continue without deliberating. Then, and only then, slow down at the card step. If you catch yourself reading, comparing, or re-checking anything before the card step, STOP and just take the obvious action.

THINKING BUDGET BY PHASE — spend thought ONLY where the page demands it:
- ARRIVAL (cookies, the Book/Reserve button): zero thought — the system pre-clicks these for you; if you still land on a marketing page, click the booking CTA immediately without reading anything else.
- DATES + PARTY: your FIRST action on any dates step is SETTING the dates — type them or click the cells immediately, never 'survey' the calendar first. You already KNOW the dates and party from the task: read the month header once, compute the month-clicks, fire them, click the two day cells, set guests, hit Search. 2-4 steps. THINK ONLY IF a date is greyed-out/unavailable — that's the one dates situation worth deliberation (nearest available alternative, then note the change in your report).
- ROOM / RATE LIST / TEE-TIME SLOTS / VEHICLE LIST: reflex, not thought. Hotels: the cheapest visible option with a Book/Select button. Golf: the slot at (or nearest to) the requested time. Cars: the closest match to the requested class. Click it on the SAME step you see the list — there is nothing to weigh; the customer reviews the price afterwards.
- GUEST DETAILS: brisk — target ≤3 steps, zero deliberation. EVERY answer is already in the task: Title/honorific is GIVEN (never spend a step deciding Mr/Ms — a real run burned 3 minutes on this and still chose wrong), residence country/state comes from the home-airport line, name/email/phone are verbatim. ONE batched fill for the text fields, selectOptionFromDropdown for Title/state/country dropdowns, tick required boxes, click Continue/Next. Filling this form is mechanical transcription, not judgment. A SYSTEM AUTOFILL runs alongside you and often fills these fields the instant the form appears — if fields already show the correct values, do NOT re-type them; just handle anything still empty (dropdowns, checkboxes) and click Continue. PHONE fields with a COUNTRY-CODE dropdown: set the country to match the number's prefix FIRST (+1 → United States), then type only the national digits — never submit under a wrong default country (a real run filed a US number under +90 Turkey). ADDRESS fields: use the task's home-address line EXACTLY — type into the manual street/city/state/zip fields and SKIP any "find your address" autocomplete. If a street address is REQUIRED and the task has none, report needs_review asking the customer to add their home address — never invent one.
- PAYMENT: the ONE place to slow down a little — confirm the total shown, then stop before card digits (the system enters payment).
PER-STEP PACE: one short thought, then ONE decisive action. Never write long reasoning; never re-derive something you already know.

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
- INQUIRY / TRIP-PLANNER FORMS: "Plan My Trip", "Request a Quote", "Enquire Booking", "Request Information", "Contact Us", "Anfragen", "Richiesta" — forms that collect details so a HUMAN confirms later are INQUIRIES, not instant bookings. FIRST look for a real booking engine ("Book"/"Reserve"/"Tee Times" with live DATE fields) — that always wins. BUT if the venue genuinely offers ONLY an enquiry path (no live availability anywhere), DO THE CONCIERGE MOVE: fill the enquiry form with the full reservation request — dates, party size, the traveler's name/email/phone, and a short message ("Requesting [room/tee time] for [dates], [N] guests — please confirm availability to this email") — submit it ONCE, then report needs_review with reason "enquiry_sent", stating exactly what was requested. NEVER report an enquiry as confirmed — the venue confirms directly with the customer. If there is no enquiry form either (phone only), report failed / form_not_found with the phone number. SPEED: the big US golf RESORTS — Pebble Beach ("plan my trip" / "Reservation Inquiry"), Pinehurst, Bandon Dunes, Sea Island — book this way ONLY: there is no instant online checkout, just the inquiry. Recognize it on sight and be DECISIVE — your dates are auto-filled for you, so you only need to set the rooms + GUESTS/GOLFERS count to the party size (if it shows 0 it's a required field — set it), fill your contact details, and SUBMIT in a HANDFUL of steps. Do NOT keep hunting for a "book"/rate page that does not exist on these resorts, and do NOT re-read the page over and over — fill the highlighted required fields and submit.
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
6-NOCARD. PAY-AT-PROPERTY / "DUE AT COURSE" (NO card required): MANY golf tee times and some hotel/dining reservations confirm with NAME + CONTACT only and charge later — the price box reads "Due at Course" / "Pay at property" / "Pay at check-in" / "$0 due now" and there is NO credit-card field anywhere on the final step, just a "Book"/"Reserve"/"Confirm"/"Complete Reservation" button. In that case do NOT stop — there is no payment step to hand off. FILL the guest details, tick the mandatory consents, and CLICK the final Book/Confirm button to COMPLETE the reservation, then read the confirmation number. Reaching a confirmation page (or "your tee time is booked", a confirmation #) is the SUCCESS outcome — report it confirmed with the number. Stopping at a no-card confirm screen and calling it "needs review" is a FAILURE; if no card is asked for, you finish the booking.
6a. CHECKOUT CONSENT TOGGLES — the last gate before payment. Booking forms gate the Pay button behind MANDATORY consent checkboxes/toggles ("I accept the cancellation policy", "I accept the terms and conditions", "I consent to my data being processed to complete my booking" / "Accetto", "Acconsento"). TICK EVERY MANDATORY one (they're usually grouped under "Mandatory"/"Required") — these are required to book and are always safe to accept; leaving them off is why a checkout shows "you must accept the mandatory terms" and the run stalls. Leave OPTIONAL ones (marketing, analytics, profiling / "I consent to marketing") OFF. NEVER click "Learn more" / "Read more" / policy links, and NEVER open or read a Terms/Privacy page or new tab — a real run opened the privacy disclosure and burned minutes reading GDPR text. Just flip the mandatory toggles and proceed to Pay. If a stray Terms/Privacy tab opened, close it and return to the checkout tab.

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
- SOLD-OUT REQUESTED DATES: if the task's check-in/check-out (or ANY night of the stay, for a hotel) is marked "Sold out" / greyed-out / unavailable on the calendar, do NOT substitute different dates. The customer's trip is fixed to their flights — booking other dates is a serious failure. Report failed / no_availability and name the dates that are sold out. (Our system then offers the customer a bookable alternative property — that's not your job; just report it cleanly.) Only the EXACT requested dates are acceptable; if they're unavailable, stop and say so.

HOTEL PLAYBOOK
1. The booking widget is almost always RIGHT ON THE HOMEPAGE — the "Check in — Check out / Guests / Check Rates" bar in the hero. USE IT IN PLACE. Do NOT navigate off to a separate "Reservations" / "Book" page hunting for a form when one is already on screen. Only go looking for a "Book"/"Reserve"/"Check Availability" link if there is genuinely no date widget visible.
2. BATCH the search inputs: in as few turns as possible, set check-in, set check-out, set the guest/room count, THEN click Check Rates / Search. Fill the dates and guests together — don't burn one turn per field, and don't take a step just to confirm a field "took". One decisive turn of inputs, then search. GUESTS: the widget almost always DEFAULTS TO 1 ADULT — you MUST change it to the party size in the task (e.g. 2 adults for a 2-person trip). Booking the wrong headcount is a real failure; set the guest count explicitly, never leave it at the default 1.
3. Pick a room. **The room/suite name in the task is a PREFERENCE, not a requirement.** If the exact named room (e.g. "Junior Suite") isn't listed, pick the CHEAPEST available room that sleeps the party. The search returning rooms — even differently-named ones — means the hotel IS available: select one and CONTINUE. Quitting because the named room isn't listed is a failure you must never make. Don't compare every room or re-read the page — choose one and move on.
4. WHEN THE PAGE SHOWS RATES WITH "RESERVE" / "BOOK" / "SELECT" BUTTONS, YOUR ACTION IS TO CLICK ONE — on the SAME step you see the list, not a later one. Do not keep reading. Do not "pause to think". Do not scroll through all the rooms first. The first room card visible that fits the party: click its Select/Book. If multiple rate options for the same room are shown (e.g. "Best Flexible Rate" vs "Best Flexible With Breakfast"), pick the CHEAPEST and click ITS button. After clicking Select, NEVER go back to re-compare rooms — push forward to guest details. Sitting on a rate list without clicking is the same failure as quitting (a real run died at the time cap staring at a rate list it had already earned).
4a. AVAILABILITY GRID / MATRIX (rows = room types, columns = individual nights, cells full of × marks and per-night prices): do NOT try to click the per-night cells or decode the grid — that grid is just an availability calendar. Look at the RIGHT-HAND column, where each room that's bookable for the WHOLE stay shows a total price ("incl. taxes & fees") next to a "Book now" / "Book" button. IMMEDIATELY click the "Book now" of the CHEAPEST room with a bookable total. Ignore rows that say "Not available" / "Available on [date]" (those can't be booked for the full stay). One glance at the right column, pick the lowest total with a Book button, click it — do not dwell on this page, it is the single most time-consuming page in the flow.
4b. ROOM CARDS with "VIEW OFFERS" / "VIEW RATES" / "SELECT" / "CHOOSE" buttons and a "FROM $X / night" price (each room is a photo card you can scroll past): this is a room LIST, not the final rates. Do NOT scroll through every room reading descriptions, amenities (Robes, Coffee & Tea, Room Service), or photo galleries — that is wasted motion that burns the clock. Pick the CHEAPEST room and IMMEDIATELY click ITS "View Offers"/"View Rates"/"Select" button to open its rates, then pick the cheapest rate and continue to guest details. Never click "View More"/"Read more"/photo arrows. The moment you see room cards with a select/offers button, your next action is to CLICK one — not to read.
5. PRICE — pick the CHEAPEST suitable room and BOOK IT even when it costs more than the task's estimate. Quote the real total in your message (e.g. "Portonovi Room — $20,205 for 9 nights, above the $16,200 estimate"). Walking away over price is a failure; the customer approves/cancels, not you.
5a. "ENHANCE YOUR STAY" / UPSELL SCREEN (after the room, before guest details — Marriott/Hilton/SHR show one): DECLINE every add-on unless the task asked for it — breakfast, parking, late checkout, early check-in, room upgrade, spa credit, travel insurance. Skip/"no thanks" and advance in one pass; don't deliberate. RATE POLICY: if the task names a policy (refundable vs non-refundable, member vs standard), honour it; otherwise take the cheapest flexible/refundable rate over a cheaper non-refundable one when both are shown.
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
- "LOG IN OR SIGN UP" with an EMAIL field + "Continue" (Access/golfwithaccess
  checkout step): this is GUEST CHECKOUT, not a mandatory account. The email is
  already filled — just click "Continue" to proceed to the payment/confirm step.
  Do NOT try to create a password account or stop here.
- "WE WERE UNABLE TO VERIFY YOUR BROWSER" / "please verify your browser": this
  is the venue's BOT DETECTION, and reloading will NOT clear it. Do not loop on
  it. Report failed / captcha_blocked plainly — the system retries with stealth.

GOLF / TEE-TIME PLAYBOOK
- The booking lives under "Tee Times", "Book a Tee Time", "Golf", "Reserve", or a resort's "Experiences" / "Recreation" section — open it.
- RESORT / MARKETING GOLF PAGE — DIG, DON'T GIVE UP. When you land on a golf page that's pure marketing (a hero photo + "About the Course / Pro Shop / Golf Lessons" cards + a "Check Availability" bar that's really the HOTEL's room widget — e.g. One&Only "Experiences › Golf"), the tee sheet is almost always ONE or TWO clicks deeper behind a secondary link. Do NOT report form_not_found after one look — LOOK HARD and click the most booking-like link, in this order: "BOOK A TEE TIME" / "TEE TIMES" / "RESERVE" → then "ABOUT THE COURSE" / "VIEW THE COURSE" / "MORE INFO" / "PLAN YOUR GAME" → then the COURSE'S OWN NAME as a link (resorts link out to the golf club's own site / tee sheet, often on a different domain — follow it). Follow ONE hop; if that page has a Book / Tee-time button or a date+players widget, use it. The "Check Availability" date bar on a golf marketing page is usually for HOTEL ROOMS, not golf — don't book a room when the task is a tee time; find the golf-specific booking link instead. Only after you've tried the booking links AND the course-name link and there's genuinely no online tee sheet (phone / concierge / "arranged through the Golf Shop" only) do you report form_not_found, quoting the phone/email.
- Many courses embed a booking widget (GolfNow, Lightspeed/Chronogolf, ForeUp, TeeQuest). That widget IS the real booking system — use it, even if the URL host changes.
- Set the DATE and number of PLAYERS (light thinking — you KNOW both from the task), then the slot list is a REFLEX: click the tee time at or nearest the requested time on the SAME step you see the grid — don't compare slots, don't re-read. Clicking the slot opens the form; batch-fill the player/contact details and book. If a card/deposit is required, STOP per rule 6.
- THE SPECIFIC COURSE IS A PREFERENCE, NOT A REQUIREMENT. Many clubs have MULTIPLE courses (Troon North = Monument + Pinnacle; Pebble, Bandon, Streamsong all have several). If the task names a course (e.g. "Monument Course") but that one has NO open tee times for the date, BOOK AN AVAILABLE TEE TIME AT ANOTHER COURSE AT THE SAME CLUB — the customer wants to play this CLUB; which of its courses is secondary. NEVER report "no availability" while other courses at the same facility have open slots (a real run found 58 tee times at Troon North, all Pinnacle, and wrongly quit because it wanted Monument). Clear/ignore the course filter, take ANY available course's nearest time, and book it. Only report no_availability when the WHOLE club has no tee times that day.
- NO SLOTS ON THE REQUESTED DATE: if after setting the date the page shows an EMPTY slot list and a "next available date" hint (e.g. "Next available date 15-06-2026 11:10" / "Prossima data disponibile…" / "Next tee time…"), do NOT sit on the page waiting and do NOT keep re-reading. The course is simply full that day. STOP at once and report failed / no_availability, quoting the next-available date the site showed. One decisive read, then report — never linger on a sold-out date.
- "CHOOSE YOUR RATE" STEP (the last gate before confirming — Access/golfwithaccess, GolfNow, many tee sheets): after you pick a tee time you land on a rate page with options like "Public — Standard rate $135 ◯" each with a RADIO/CIRCLE on the right, and a GREYED-OUT "Select rate to continue" / "Continue" / "Book" button. That button is disabled UNTIL you select a rate. CLICK THE RADIO/CIRCLE of the plain PUBLIC / STANDARD rate (the cheapest non-membership option) — this ENABLES the button — THEN click "Select rate to continue" / "Continue". Do NOT pick "Premium+ / Membership / Join to save" upsell rates: those require creating a paid membership account and are NOT how a guest books. Pick the standard public rate, click its circle, continue.

CAR-RENTAL PLAYBOOK
1. Find the rental search — pick-up location, pick-up date/time, and drop-off date/time. Set them from the task (use the city/airport in the task as the pick-up location).
2. Search, then pick a vehicle. **The car class in the task (e.g. "Luxury SUV", "Standard") is a PREFERENCE.** If that exact class isn't offered, pick the closest available vehicle that fits the party and budget — never quit because the named class isn't listed.
3. Choose "pay at counter" / "pay later" over prepaid when both exist (avoids the card step).
3a. THE ADD-ONS / "PROTECTION" SCREEN is the #1 car-rental time sink — do NOT deliberate on it. DECLINE EVERY extra unless the task explicitly asked for it: insurance/CDW/coverage upgrades, GPS, child/booster seat, additional driver, prepaid fuel, toll pass, satellite radio, roadside. Uncheck/select "no thanks"/"decline" and advance in one pass. Set ONLY: vehicle class, pick-up/drop-off location, pick-up/return date+time, driver details. Everything else is skip-and-proceed.
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

  // Hard wall-clock — abort the agent if it runs long.
  const controller = new AbortController();
  // HEAVY-PAGE WATCHDOG: ariaTree/extract timeouts mean the agent is BLIND
  // (the page's DOM is too large to serialize inside the tool timeout).
  // One or two can be ridden out; three+ means this site is unreadable and
  // every further step is wasted clock (Sentosa, aman.com: the agent 'just
  // sat there'). Count them via Stagehand's logger hook and abort early
  // with an honest fallback instead.
  let blindReads = 0;
  let heavyAbort = false;
  const watchdogLogger = (line: { message?: string; category?: string }) => {
    const m = line?.message ?? "";
    if (/ariaTree\(\) timed out|extract\(\) timed out/.test(m)) {
      blindReads += 1;
      if (blindReads >= 3 && !heavyAbort) {
        heavyAbort = true;
        console.warn(
          `[stagehand] ✗ heavy-page watchdog: ${blindReads} blind reads — aborting run, falling back to website/phone`,
        );
        controller.abort();
      }
    }
  };

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
      logger: watchdogLogger as never,
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
      logger: watchdogLogger as never,
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

  // Hard wall-clock — abort the agent if it runs long. (Declared with the
  // heavy-page watchdog ABOVE the provider branch so both Stagehand
  // constructions can reference the logger.)
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
    // Hand the live-view URL to the app NOW (not at the end) so a "Watch live"
    // link can appear while the run is in flight.
    try {
      await opts.onSessionReady?.(sessionUrl);
    } catch {
      /* never let a UI callback break the booking */
    }

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
    // DOM DIET: network blocking can't shrink MARKUP. Mega marketing pages
    // (Sentosa, aman.com) carry videos/canvases/thousand-node decorative
    // SVGs that blow the agent's page reads past the tool timeout — the
    // agent goes blind. Strip the heavy nodes the booking flow never needs.
    await slimHeavyDom(page);

    await opts.onStep?.(`Opening ${shortHost(opts.startUrl)}…`);
    await page.goto(opts.startUrl, {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });
    console.log(`[stagehand] ✓ navigated to ${opts.startUrl} (${elapsed()})`);
    // ONE TAB: force all links + window.open into THIS tab so the booking can
    // never split across tabs (which makes the live view look idle on the
    // wrong tab — Carson's "is it even working?" confusion). Re-applied per
    // step after navigations.
    await forceSingleTab(page);

    // BOT-WALL on landing: many venue MARKETING sites (Troon's troonnorthgolf
    // .com, big chains) sit behind CloudFront/Akamai/Cloudflare and return a
    // 403 "Request could not be satisfied" / "Access Denied" to automation.
    // The real booking engine is elsewhere (golfwithaccess.com for Troon), so
    // grinding this page is hopeless. Detect it in one cheap read and FAIL FAST
    // → the retry loop re-attempts on a fresh residential IP with stealth, and
    // if it's still walled, the customer gets an honest fallback link instead
    // of a 4-minute hang.
    const botWall = await detectBotBlock(page);
    if (botWall) {
      console.warn(
        `[stagehand] ✗ bot-wall on landing (${botWall}) at ${shortHost(opts.startUrl)} — failing fast for a stealth retry (${elapsed()})`,
      );
      return {
        outcome: {
          status: "failed",
          failureReason: "captcha_blocked",
          message: `The venue's site blocked automated access (${botWall}). Retrying on a fresh connection; if it stays blocked, finish on the venue's site directly.`,
        },
        sessionUrl,
        finalScreenshot: null,
      };
    }

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

    // FAST PATH: click the obvious booking CTA ("Book now" / "Reserve" /
    // "Check availability") deterministically — one in-page DOM scan, no
    // LLM call, no full-page read. Marketing homepages cost the agent its
    // first 2-5 steps just finding this button (and mega-pages like
    // aman.com blinded it entirely); a human's first move is the big BOOK
    // button, so make it free. Best-effort: no match ⇒ the agent navigates
    // as before.
    try {
      const entry = await clickBookingEntryDeterministically(page);
      if (entry) {
        console.log(
          `[stagehand] ✓ booking CTA clicked deterministically ("${entry}") (${elapsed()})`,
        );
        await opts.onStep?.("Opening the booking page…");
        // Give the click's navigation a beat to start so the agent's first
        // read sees the booking engine, not the marketing page mid-unload.
        await new Promise((r) => setTimeout(r, 1500));
        await slimHeavyDom(page);
      } else {
        console.log(
          `[stagehand] no obvious booking CTA on landing page — agent will navigate (${elapsed()})`,
        );
      }
    } catch (e) {
      console.warn(
        `[stagehand] booking-CTA fast path skipped: ${e instanceof Error ? e.message : e}`,
      );
    }

    // These fast-paths also re-run after EVERY agent step (see onStepFinish)
    // because multi-page flows (Pebble Beach: land → "plan my trip" inquiry →
    // calendar appears) only show the form LATER. Running once at the start
    // missed it and the agent hand-cranked the rest. Track "done" so we set
    // each thing exactly once.
    let datesAlreadySet = false;
    let slotAlreadyPicked = false;
    let golfSearchSubmitted = false;
    let rateSelected = false;
    let roomPicked = false;
    // Hotels AND cars use the same cheapest-priced-card picker (room cards /
    // vehicle cards are the same shape: a priced card + a Select/Book/Reserve
    // CTA). And hotels, cars, AND golf can all interpose an add-on/upsell page
    // (hotel enhancements, car protection/extras, golf cart/club rental), so
    // the one-click upsell skip should fire for all three — not hotels only.
    const pickCards = !!(opts.selectRoom || opts.selectVehicle);
    const skipUpsell = !!(opts.selectRoom || opts.selectVehicle || opts.selectTeeSlot);
    // Hotels often need a SECOND priced pick after the room: a rate-plan list
    // ("Standard Daily Rate · Reserve" / "Wellness Escape · Reserve" — Aman,
    // SHR). Same shape as the room list (priced card + Reserve/Book CTA), so we
    // re-use the room picker for it, gated on its own flag + that the room was
    // picked on an EARLIER step (so it can't re-click the room on the same DOM).
    let rateCardPicked = false;
    let roomPickedAtStep = -1;
    // One-shot guard so the calendar diagnostic dumps at most once per run.
    let calendarDiagnosed = false;
    // true ONLY when the date setter confirmed "in=…". Gates the room picker
    // (in the conductor AND the per-step pass) so it can't fire on a calendar.
    let datesConfirmed = false;
    let verifyWallHits = 0;
    let verifyWallBlocked = false;

    // FAST PATH: set the stay DATES deterministically. The dual-month price
    // calendars on luxury sites (aman.com) are so heavy the agent's page
    // read (ariaTree) TIMES OUT — it could set arrival but not departure.
    // Dates are mechanical: we already KNOW them, so click the exact cells
    // in-page by their date metadata (aria-label / title / data-date), no
    // LLM and no full-page read. Polls briefly because the calendar appears
    // a moment after the Book-Now navigation. Best-effort: on no match the
    // agent sets dates the normal way.
    if (opts.checkinISO) {
      try {
        let setDates: string | null = null;
        // Poll: the calendar appears a beat after the Book-Now navigation, and
        // a closed calendar needs one pass to ARM it (returns "OPENED") before
        // the cells exist to click. Keep going while we're still null/OPENED.
        for (
          let i = 0;
          i < 7 && (!setDates || setDates === "OPENED");
          i++
        ) {
          setDates = await clickStayDatesDeterministically(
            page,
            opts.checkinISO ?? null,
            opts.checkoutISO ?? null,
          );
          if (!setDates || setDates === "OPENED") {
            await new Promise((r) => setTimeout(r, 1200));
          }
        }
        // Arrival landed but the departure cell wasn't selectable yet (many
        // range pickers only enable check-out after check-in is chosen). Run
        // dedicated checkout-only passes so the agent inherits a COMPLETE range
        // and never has to touch the calendar at all.
        if (setDates && setDates.includes("out=PENDING")) {
          for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 1200));
            const outRes = await clickStayDatesDeterministically(
              page,
              null,
              opts.checkoutISO ?? null,
            );
            if (outRes) {
              setDates = `in=${opts.checkinISO} out=${opts.checkoutISO}`;
              break;
            }
          }
        }
        if (setDates && setDates !== "OPENED") {
          datesAlreadySet = true;
          console.log(
            `[stagehand] ✓ stay dates set deterministically (${setDates}) (${elapsed()})`,
          );
          await opts.onStep?.(
            opts.checkoutISO ? "Dates set — finding your room…" : "Date set — finding your time…",
          );
        } else {
          console.log(
            `[stagehand] no auto-settable calendar (${setDates ?? "no match"}) — agent will set dates (${elapsed()})`,
          );
        }
      } catch (e) {
        console.warn(
          `[stagehand] date fast path skipped: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // FAST PATH (GOLF): click the tee-time SLOT. The booking widgets (ForeUp,
    // Chronogolf, TeeQuest) render a LIST of available times; the agent's only
    // job there is to click one — yet a real run sat on a full ForeUp slot list
    // the entire time budget without clicking. Picking the slot in-page (zero
    // LLM, nearest the requested time) removes that stall entirely, the same
    // way the date fast-path removed the calendar stall. Polls because the slot
    // list appears a beat after the date/search. Best-effort.
    if (opts.selectTeeSlot) {
      try {
        // Some tee sheets (quick18/Grayhawk, ForeUp) gate the slot list behind
        // a SEARCH FORM — submit it first so the slots actually render.
        const searched = await clickGolfSearchDeterministically(page);
        if (searched) {
          console.log(
            `[stagehand] ✓ golf search submitted ("${searched}") (${elapsed()})`,
          );
          golfSearchSubmitted = true;
          await new Promise((r) => setTimeout(r, 2000));
        }
        let picked: string | null = null;
        for (let i = 0; i < 6 && !picked; i++) {
          picked = await clickTeeTimeSlotDeterministically(
            page,
            opts.teeTimeLabel ?? null,
          );
          if (!picked) await new Promise((r) => setTimeout(r, 1500));
        }
        if (picked) {
          slotAlreadyPicked = true;
          console.log(
            `[stagehand] ✓ tee-time slot clicked deterministically (${picked}) (${elapsed()})`,
          );
          await opts.onStep?.("Tee time selected — filling your details…");
          await new Promise((r) => setTimeout(r, 1200));
          await slimHeavyDom(page);
        } else {
          console.log(
            `[stagehand] no tee-slot list matched — agent will pick the time (${elapsed()})`,
          );
        }
      } catch (e) {
        console.warn(
          `[stagehand] tee-slot fast path skipped: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // ── DETERMINISTIC CONDUCTOR (Carson's "just click, don't read") ──────────
    // Drive the booking with our zero-LLM recognizers in a loop — consent →
    // Book CTA → dates → search → room/slot → rate → guest fill → advance — each
    // step matched by MEANING so it adapts to any form's layout. Only when the
    // recognizers can't make progress (a genuinely novel widget) do we hand off
    // to the AI agent below. On forms it recognizes end-to-end, this reaches the
    // card step with NO model calls at all — fast and consistent, every form.
    let conductorReachedCard = false;
    let dateArmAttempts = 0;
    try {
      const tick = async (): Promise<string | null> => {
        const p = stagehand.context.activePage() ?? page;
        if (!p) return null;
        await forceSingleTab(p);
        await dismissConsentDeterministically(p, { safe: true });
        // Reached the card step → stop, the payment phase takes over.
        if (await detectCardFieldPresent(p)) {
          conductorReachedCard = true;
          return null;
        }
        // GOLF: search → slot → rate.
        if (opts.selectTeeSlot) {
          if (!slotAlreadyPicked) {
            const r = await clickTeeTimeSlotDeterministically(p, opts.teeTimeLabel ?? null);
            if (r) { slotAlreadyPicked = true; return `slot ${r}`; }
          }
          if (!golfSearchSubmitted) {
            const s = await clickGolfSearchDeterministically(p);
            if (s) { golfSearchSubmitted = true; return `golf-search "${s}"`; }
          }
          if (!rateSelected) {
            const r = await selectCheapestRateRadioDeterministically(p);
            if (r) { rateSelected = true; return `rate ${r}`; }
          }
        }
        // DATES FIRST (hotel + golf). On a single pre-filled RANGE input the
        // setter can't confirm "in=…" and would "OPENED"-arm forever, blocking
        // the advance click — so after a few arm attempts assume the dates are
        // already right and move on.
        if (opts.checkinISO && !datesAlreadySet) {
          const r = await clickStayDatesDeterministically(p, opts.checkinISO ?? null, opts.checkoutISO ?? null);
          if (r && r !== "OPENED" && r.startsWith("in=")) {
            datesAlreadySet = true;
            datesConfirmed = true;
            return `dates ${r}`;
          }
          if (r) {
            // First time the calendar comes back un-settable, dump what's on
            // the page so we can fix the recognizer precisely (vs. guessing).
            if (r === "OPENED" && !calendarDiagnosed) {
              calendarDiagnosed = true;
              const diag = await diagnoseCalendar(p);
              console.log(`[stagehand] 🔬 calendar diag :: ${diag}`);
            }
            dateArmAttempts += 1;
            if (dateArmAttempts >= 3) datesAlreadySet = true; // give up → advance
            return `dates ${r}`;
          }
        }
        // HOTEL room / CAR vehicle → rate. The picker has its own calendar-step
        // guard (it bails while a date picker is on screen) AND requires a real
        // priced card CTA, so it's safe to run every tick — we do NOT gate it
        // on datesConfirmed, which wrongly stayed false (disabling the picker
        // for the whole run) whenever the AGENT, not our code, set the dates.
        if (pickCards) {
          if (!roomPicked) {
            const r = await clickCheapestRoomDeterministically(p);
            if (r) { roomPicked = true; return `room ${r}`; }
          } else if (!rateCardPicked) {
            // SECOND priced list (rate plans with Reserve/Book buttons). Runs
            // on the NEXT tick after the room pick (the return above splits
            // them), so it can't re-click the room on the same DOM.
            const r = await clickCheapestRoomDeterministically(p);
            if (r) { rateCardPicked = true; return `rate-card ${r}`; }
          }
          if (!rateSelected) {
            const r = await selectCheapestRateRadioDeterministically(p);
            if (r) { rateSelected = true; return `rate ${r}`; }
          }
        }
        // ADD-ON / UPSELL step → continue past it in one click. Hotels
        // (enhancements), cars (protection/extras), golf (cart/club rental) all
        // interpose one; a real hotel run wasted 330s grinding it. Self-guards
        // to the upsell step, so it's safe for all three.
        if (skipUpsell) {
          const up = await clickThroughUpsellDeterministically(p);
          if (up) return `upsell-skip "${up}"`;
        }
        // GUEST DETAILS autofill.
        if (opts.autofill) {
          const n = await deterministicGuestFill(p, opts.autofill);
          if (n > 0) return `autofill ${n} fields`;
        }
        // Off a marketing page → click the Book CTA.
        const cta = await clickBookingEntryDeterministically(p);
        if (cta) return `book-cta "${cta}"`;
        // Advance to the next step (Search / Continue / Next) — never commits.
        // Only advance once dates are handled, so we don't skip the date step.
        if (datesAlreadySet || !opts.checkinISO) {
          const adv = await clickAdvanceButtonDeterministically(p);
          if (adv) return `advance "${adv}"`;
        }
        return null;
      };
      let stalls = 0;
      for (let i = 0; i < 24 && !controller.signal.aborted; i++) {
        const action = await tick();
        if (conductorReachedCard) break;
        if (action) {
          stalls = 0;
          console.log(`[stagehand] ⚙ conductor → ${action} (${elapsed()})`);
          await opts.onStep?.(progressLabel(i + 1));
        } else if (++stalls >= 3) {
          break; // novel widget — hand to the AI agent
        }
        await new Promise((r) => setTimeout(r, 1400));
      }
      console.log(
        `[stagehand] conductor ${conductorReachedCard ? "reached card step — skipping agent" : "handed off to agent"} (${elapsed()})`,
      );
    } catch (e) {
      console.warn(`[stagehand] conductor error (continuing to agent): ${e instanceof Error ? e.message : e}`);
    }

    // DOM-mode agent: act / fillForm / extract / goto via the page's
    // accessibility tree — no screenshots, no coordinate guessing. Runs ONLY
    // when the conductor above didn't already reach the card step.
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
    let stepCount = 0;
    // The conductor already drove to the card step → skip the AI booking loop
    // entirely (the payment phase below still uses `agent` to enter the card).
    type ExecResult = Awaited<ReturnType<typeof agent.execute>>;
    let result: ExecResult;
    if (conductorReachedCard) {
      console.log("[stagehand] ✓ conductor reached the card step — no AI booking loop needed.");
      result = {
        success: true,
        completed: false,
        message:
          "Filled in the whole reservation and reached the card step (deterministic conductor).",
        actions: [],
      } as unknown as ExecResult;
    } else {
    console.log(
      `[stagehand] agent.execute starting (maxSteps=${maxSteps}, toolTimeout=${TOOL_TIMEOUT_MS}ms)…`,
    );
    result = await agent.execute({
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
          // BOT-DETECTION WALL mid-flow: Access's "verify your browser", or a
          // Hilton/Marriott/Akamai "Something went wrong / Reference No." block
          // that appears AFTER navigation (not just at landing). Reloading
          // doesn't clear these — if it persists across steps, abort fast so the
          // retry runs through the residential proxy / stealth, which is the
          // only thing that slips past fingerprint detection.
          if (!verifyWallBlocked) {
            try {
              const active = stagehand.context.activePage();
              const walled =
                active &&
                ((await detectVerifyWall(active)) ||
                  (await detectBotBlock(active)) != null);
              if (walled) {
                verifyWallHits += 1;
                if (verifyWallHits >= 2) {
                  verifyWallBlocked = true;
                  console.warn(
                    `[stagehand] ✗ bot-detection wall persists — aborting for a proxy/stealth retry (${elapsed()})`,
                  );
                  controller.abort();
                }
              } else {
                verifyWallHits = 0;
              }
            } catch {
              /* best-effort */
            }
          }
          // STICKY POPUP CLEAR (per step, SAFE mode): cookie/privacy banners
          // often appear a page or two in (golfwithaccess's "We value your
          // privacy / Do Not Sell" popup shows on the slot page, not landing)
          // and intercept clicks. Safe mode only touches known cookie managers
          // + scoped privacy banners — never the generic Accept/Continue scan,
          // which could mis-click a booking button.
          try {
            const active = stagehand.context.activePage();
            if (active) {
              const cleared = await dismissConsentDeterministically(active, {
                safe: true,
              });
              if (cleared)
                console.log(
                  `[stagehand] ⚡ dismissed sticky popup ("${cleared}") (${elapsed()})`,
                );
              // Keep everything in one tab (the override resets on navigation).
              if (active) await forceSingleTab(active);
            }
          } catch {
            /* best-effort */
          }
          // INSTANT GUEST AUTOFILL: zero-LLM pass on the active page after
          // every step. When a guest/checkout form appears, every recognised
          // empty field (names, email, phone, address, title) is filled in
          // ~100ms — the agent then verifies and clicks Continue instead of
          // typing field-by-field at ~10s a step (a Belmond run burned
          // minutes transcribing data we already had).
          if (opts.autofill) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const filled = await deterministicGuestFill(active, opts.autofill);
                if (filled > 0)
                  console.log(
                    `[stagehand] ⚡ autofill completed ${filled} guest fields (${elapsed()})`,
                  );
              }
            } catch {
              /* best-effort */
            }
          }
          // INSTANT DATE-SET (per step): the calendar often appears only after
          // the agent navigates a page or two (Pebble Beach's inquiry form, a
          // hotel's "check availability" step). Re-run the deterministic date
          // setter on the active page until it lands ONCE — so code sets the
          // dates the moment the widget shows, instead of the agent grinding it.
          if (opts.checkinISO && !datesAlreadySet) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const r = await clickStayDatesDeterministically(
                  active,
                  opts.checkinISO ?? null,
                  opts.checkoutISO ?? null,
                );
                if (r && r !== "OPENED" && r.startsWith("in=")) {
                  datesAlreadySet = true;
                  datesConfirmed = true;
                  console.log(
                    `[stagehand] ⚡ dates set mid-run (${r}) (${elapsed()})`,
                  );
                }
              }
            } catch {
              /* best-effort */
            }
          }
          // INSTANT TEE-SLOT (per step): same idea for golf — the slot list can
          // render a step or two in. Click the nearest slot the moment it shows.
          if (opts.selectTeeSlot && !slotAlreadyPicked) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const r = await clickTeeTimeSlotDeterministically(
                  active,
                  opts.teeTimeLabel ?? null,
                );
                if (r) {
                  slotAlreadyPicked = true;
                  console.log(
                    `[stagehand] ⚡ tee slot picked mid-run (${r}) (${elapsed()})`,
                  );
                } else if (!golfSearchSubmitted) {
                  // No slots yet — the search form may have just appeared.
                  // Submit it so the list renders on the next step.
                  const s = await clickGolfSearchDeterministically(active);
                  if (s) {
                    golfSearchSubmitted = true;
                    console.log(
                      `[stagehand] ⚡ golf search submitted mid-run ("${s}") (${elapsed()})`,
                    );
                  }
                }
              }
            } catch {
              /* best-effort */
            }
          }
          // RATE STEP (golf): select the cheapest public rate so the greyed-out
          // Continue button enables. Runs for ANY golf booking — NOT gated on
          // our own slot-pick, because the AGENT often picks the slot itself
          // (a real Troon run reached the rate page that way and our gate kept
          // this from ever firing). Safe anywhere: no-ops unless the page has
          // unselected priced rate options.
          if (opts.selectTeeSlot && !rateSelected) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const r = await selectCheapestRateRadioDeterministically(active);
                if (r) {
                  rateSelected = true;
                  console.log(
                    `[stagehand] ⚡ rate selected mid-run (${r}) (${elapsed()})`,
                  );
                }
              }
            } catch {
              /* best-effort */
            }
          }
          // ROOM STEP (hotels): the moment a rooms/suites grid renders, click
          // the cheapest room's CTA so the agent never SITS on the list (Aman
          // sat 400s on it). The picker self-guards against the calendar step
          // and requires a real priced room CTA, so it's safe to run every
          // step — NOT gated on datesConfirmed (which stayed false, and so
          // disabled this, whenever the agent set the dates itself).
          if (pickCards && !roomPicked) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const r = await clickCheapestRoomDeterministically(active);
                if (r) {
                  roomPicked = true;
                  roomPickedAtStep = stepCount;
                  console.log(
                    `[stagehand] ⚡ room picked mid-run (${r}) (${elapsed()})`,
                  );
                }
              }
            } catch {
              /* best-effort */
            }
          }
          // RATE-PLAN step (hotels): after the room, a SECOND priced list often
          // appears — rate plans each with a "Reserve"/"Book" button (Aman:
          // "Standard Daily Rate · Reserve"). Same shape as the room list, so
          // re-use the room picker to click the cheapest. Only fires on a step
          // AFTER the room pick, so it can't re-click the room on the same DOM.
          else if (
            pickCards &&
            roomPicked &&
            !rateCardPicked &&
            stepCount > roomPickedAtStep
          ) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const r = await clickCheapestRoomDeterministically(active);
                if (r) {
                  rateCardPicked = true;
                  console.log(
                    `[stagehand] ⚡ rate plan picked mid-run (${r}) (${elapsed()})`,
                  );
                }
              }
            } catch {
              /* best-effort */
            }
          }
          // ADD-ON / UPSELL step: the moment we land on the add-on page,
          // continue past it in one click so the agent doesn't grind every
          // upsell by hand — hotel enhancements (a real Aman run burned 330s
          // here), car protection/extras (the #1 car time sink), golf cart/club
          // rental. Self-guards to the upsell step + never fires on the card.
          if (skipUpsell) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const up = await clickThroughUpsellDeterministically(active);
                if (up)
                  console.log(
                    `[stagehand] ⚡ skipped add-on/upsell page ("${up}") (${elapsed()})`,
                  );
              }
            } catch {
              /* best-effort */
            }
          }
        },
      },
    });
    }
    console.log(
      `[stagehand] ✓ agent finished (${elapsed()}) success=${result.success} completed=${result.completed} steps=${result.actions?.length ?? stepCount}\n  agent message: ${result.message?.slice(0, 600) || "(no message)"}`,
    );
    // Browser-verification wall hit: classify as captcha_blocked so the retry
    // loop re-runs with ADVANCED STEALTH (the actual unblock for bot-detection
    // walls). We aborted on purpose, so don't treat it as a crash.
    if (verifyWallBlocked) {
      console.warn("[stagehand] ✗ aborted on browser-verification wall (Access bot-detection).");
      return {
        outcome: {
          status: "failed",
          failureReason: "captcha_blocked",
          message:
            "The venue's checkout couldn't verify the browser (bot protection). Retrying with stealth; if it persists, this venue needs the API or a stealth proxy.",
        },
        sessionUrl,
        finalScreenshot: null,
      };
    }

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
          `[stagehand] payment step detected (${elapsed()}) — total=${pay.amountCents != null ? `${pay.amountCents}c ${pay.currency ?? ""}` : "unknown"}`,
        );
        // HYBRID PRICE-APPROVAL GATE (Carson's design): the agent always
        // FINISHES the work — but when the venue's real total runs above
        // the customer-reviewed estimate (+headroom), we pause HERE, before
        // any money moves, and hand the real number back for one-tap
        // approval. Within the estimate → no interruption, auto-complete.
        if (
          opts.priceGateCents != null &&
          pay.amountCents != null &&
          pay.amountCents > opts.priceGateCents
        ) {
          console.log(
            `[stagehand] price ${pay.amountCents}c above gate ${opts.priceGateCents}c — pausing for customer approval (${elapsed()})`,
          );
          return {
            outcome: {
              status: "needs_review",
              failureReason: "price_approval",
              priceCents: pay.amountCents,
              message: `Everything is filled in and ready — the venue's real total is $${Math.round(pay.amountCents / 100).toLocaleString()}${pay.currency ? ` ${pay.currency}` : ""}, above the estimate. Approve the price and Pyltrix books it immediately.`,
            },
            sessionUrl,
            finalScreenshot: null,
          };
        }
        await opts.onStep?.("Securing payment…");
        const card = await opts.cardProvider(pay.amountCents);
        if (card.status !== "ok") {
          // Couldn't charge / no saved card / Stripe off → stop cleanly at
          // payment. NEVER enter a card we don't have. Customer not charged.
          console.warn(`[stagehand] card provider unavailable: ${card.reason}`);
          return {
            outcome: {
              status: "needs_review",
              // Carry the REAL checkout total back so the app can show the
              // exact, confirmed price on the item (replaces "at checkout").
              priceCents: pay.amountCents ?? undefined,
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
        failureReason: heavyAbort ? "form_not_found" : aborted ? "timeout" : "ambiguous",
        message: heavyAbort
          ? "This venue's website is too heavy for automated booking — finish directly via the link or phone below."
          : msg,
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
        // Lean body (extra fields caused 400s) + Steel's built-in ad/tracker
        // blocker. Heavy luxury sites (aman.com: autoplay video, huge DOM)
        // blinded the agent (ariaTree timeouts) and then CRASHED the tab
        // ("no page available") — blocking at Steel's layer protects every
        // tab, including ones our per-page CDP blocklist never touches.
        timeout: Math.min(Math.max(args.timeoutMs + 60_000, 60_000), 900_000),
        dimensions: { width: AGENT_VIEWPORT.width, height: AGENT_VIEWPORT.height },
        blockAds: true,
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
  if (typeof cdp?.sendCDP !== "function") {
    console.warn(
      "[stagehand] ✗ heavy-resource blocklist SKIPPED — page object has no sendCDP (videos/trackers will load; heavy sites may blind or crash the tab)",
    );
    return;
  }
  // Images blocked by default for speed; opt OUT with =false (see IMAGE_BLOCKLIST).
  const urls =
    optionalEnv("BROWSER_AGENT_BLOCK_IMAGES") === "false"
      ? HEAVY_RESOURCE_BLOCKLIST
      : [...HEAVY_RESOURCE_BLOCKLIST, ...IMAGE_BLOCKLIST];
  try {
    await cdp.sendCDP("Network.enable");
    await cdp.sendCDP("Network.setBlockedURLs", { urls });
    console.log(
      `[stagehand] ✓ heavy-resource blocklist applied (${urls.length} patterns)`,
    );
  } catch (e) {
    console.warn(
      `[stagehand] ✗ heavy-resource block FAILED: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Strip DOM weight the booking flow never needs — videos, canvases, and
 * decorative SVGs with huge node counts. Network blocking stops downloads
 * but not markup; these nodes are what blow ariaTree/extract past the tool
 * timeout on mega marketing pages and leave the agent blind. Conservative
 * on purpose: never touches forms, iframes (embedded booking engines live
 * there), images, or hidden menus. Best-effort, never throws.
 */
async function slimHeavyDom(page: unknown): Promise<void> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return;
  try {
    const removed = await cdp.evaluate<number>(() => {
      let n = 0;
      document.querySelectorAll("video, audio, canvas").forEach((el) => {
        el.remove();
        n++;
      });
      document.querySelectorAll("svg").forEach((el) => {
        if (el.querySelectorAll("*").length > 40) {
          el.replaceWith(document.createElement("i"));
          n++;
        }
      });
      return n;
    });
    if (removed > 0)
      console.log(`[stagehand] ✓ dom diet removed ${removed} heavy nodes`);
  } catch {
    /* best-effort */
  }
}

/**
 * Force all navigation to stay in ONE tab. Booking-engine links (and JS
 * window.open calls) routinely spawn a second tab, which (a) splits the work
 * so the live view shows an idle tab and looks dead, and (b) leaves the agent's
 * deterministic passes running on the wrong page. This rewrites target=_blank
 * to _self and overrides window.open to navigate in-place. Re-run per step
 * (it resets on navigation). Best-effort — never throws.
 */
async function forceSingleTab(page: unknown): Promise<void> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return;
  try {
    await cdp.evaluate(() => {
      document
        .querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')
        .forEach((a) => {
          a.target = "_self";
        });
      const w = window as unknown as { __pyltrixSingleTab?: boolean };
      if (!w.__pyltrixSingleTab) {
        w.__pyltrixSingleTab = true;
        try {
          window.open = function (u?: string | URL): Window | null {
            if (u) {
              try {
                location.href = String(u);
              } catch {
                /* ignore */
              }
            }
            return null;
          } as typeof window.open;
        } catch {
          /* some sites freeze window.open — ignore */
        }
      }
    });
  } catch {
    /* best-effort */
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
/**
 * Deterministically click the page's obvious booking call-to-action —
 * "Book now" / "Reserve" / "Check availability" — with one in-page DOM
 * scan and zero LLM calls. Skips when the URL already looks like a booking
 * engine. Two passes: explicit booking phrases first, then bare
 * "Reserve"/"Reservations"/"Book". Returns the clicked label, or null.
 * Best-effort — never throws.
 */
/**
 * Deterministically set the check-in and check-out of a stay calendar — no
 * LLM, no full-page accessibility read (which times out on heavy price-grid
 * calendars like aman.com). Three strategies, in order of reliability:
 *
 *   1. TYPE into a writable check-in / check-out text input (one shot).
 *   2. Click cells matched by DATE METADATA (data-date / aria-label / title).
 *   3. Click cells matched by PLAIN DAY-NUMBER TEXT, scoped to the month
 *      container whose header reads the target "Month YYYY" — this is what
 *      custom JS calendars (Rocco Forte, The Lodge, Aman) render: bare "<td>21"
 *      cells with no metadata, the case that used to dump the whole calendar
 *      on the agent and stall it for dozens of steps.
 *
 * Pass `ci=null` to set ONLY the checkout (used to finish a range after the
 * arrival click armed the widget). Returns a status string on progress:
 *   "in=… out=…"    both set
 *   "in=… out=PENDING"  arrival set, checkout still needs a pass
 *   "out=…"         checkout-only pass landed
 *   "OPENED"        calendar wasn't open; clicked the arrival field to arm it
 *   null            nothing matched — let the agent do it
 * Best-effort — never throws.
 */
async function clickStayDatesDeterministically(
  page: unknown,
  checkinISO: string | null,
  checkoutISO: string | null,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(
      (arg: unknown) => {
        const { ci, co } = arg as { ci: string | null; co: string | null };
        const MONTHS = [
          "January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December",
        ];
        // Build the date strings a cell might carry for a given ISO date.
        const variants = (iso: string): string[] => {
          const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
          const dt = new Date(Date.UTC(y, m - 1, d));
          const mon = MONTHS[m - 1];
          const dd = String(d).padStart(2, "0");
          const mm = String(m).padStart(2, "0");
          const wd = [
            "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
            "Friday", "Saturday",
          ][dt.getUTCDay()];
          return [
            iso, // 2026-08-21
            `${mm}/${dd}/${y}`, // 08/21/2026
            `${dd}/${mm}/${y}`, // 21/08/2026
            `${mon} ${d}, ${y}`, // August 21, 2026
            `${d} ${mon} ${y}`, // 21 August 2026
            `${mon} ${d} ${y}`, // August 21 2026
            `${wd}, ${mon} ${d}, ${y}`, // Saturday, August 21, 2026
          ].map((v) => v.toLowerCase());
        };
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return (
            st.visibility !== "hidden" &&
            st.display !== "none" &&
            Number(st.opacity || "1") > 0.05 &&
            !(el as HTMLElement).hasAttribute("disabled") &&
            st.pointerEvents !== "none"
          );
        };

        // ── Strategy 2: metadata match ───────────────────────────────────
        const metaCells = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-date], [data-day], [aria-label], [title], td, button, a, li, span",
          ),
        );
        const findCellByMeta = (iso: string): HTMLElement | null => {
          const wants = variants(iso);
          for (const el of metaCells) {
            if (!isVisible(el)) continue;
            const meta = (
              (el.getAttribute("data-date") || "") + " " +
              (el.getAttribute("data-day") || "") + " " +
              (el.getAttribute("aria-label") || "") + " " +
              (el.getAttribute("title") || "")
            ).toLowerCase();
            if (!meta.trim()) continue;
            if (wants.some((w) => meta.includes(w))) {
              return el.closest<HTMLElement>("td,button,a,li,[role=button],[role=gridcell]") || el;
            }
          }
          return null;
        };

        // ── Strategy 3: plain day-number text, scoped to the month box ────
        const findCellByText = (iso: string): HTMLElement | null => {
          const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
          const wantDay = String(d);
          const targetKey = `${MONTHS[m - 1].toLowerCase()} ${y}`; // "september 2026"
          const looksDisabled = (el: HTMLElement): boolean => {
            const cls = (el.className || "").toString().toLowerCase();
            if (el.getAttribute("aria-disabled") === "true") return true;
            if (el.hasAttribute("disabled")) return true;
            return /disabled|outside|other-?month|adjacent|muted|unavailable|past|blocked|not-?allowed|faded/.test(
              cls,
            );
          };
          // Abbreviated month names → full, so headers like "AUG 2026" or
          // "Sept 2026" resolve (luxury calendars love abbreviations).
          const ABBR: Record<string, string> = {
            jan: "january", feb: "february", mar: "march", apr: "april",
            jun: "june", jul: "july", aug: "august", sep: "september",
            sept: "september", oct: "october", nov: "november", dec: "december",
          };
          // Month+year → normalized key, from a raw string.
          const headerKey = (raw: string): string | null => {
            const t = raw.trim().toLowerCase();
            const yr = t.match(/\b(20\d{2})\b/)?.[1];
            let mon = MONTHS.find((mn) => t.includes(mn.toLowerCase()))?.toLowerCase();
            // Fall back to an abbreviation (whole-word) if no full name matched.
            if (!mon) {
              for (const ab of Object.keys(ABBR)) {
                if (new RegExp(`\\b${ab}\\b`).test(t)) { mon = ABBR[ab]; break; }
              }
            }
            return mon && yr ? `${mon} ${yr}` : null;
          };
          const cleanHdr = (s: string): string =>
            s
              // Strip nav arrows + punctuation luxury calendars bake into the
              // header ("‹ August 2026 ›", "« AUG 2026 »").
              .replace(/[‹›<>«»→←⟨⟩❮❯|·•–—]+/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          // Find month headers by scanning TEXT NODES, not whole elements. The
          // month label ("AUGUST 2026") is often a BARE text child of a box
          // that ALSO holds the day grid — so no element's whole text is just
          // "AUGUST 2026", and element-matching finds zero headers and bails.
          // This was why Aman's calendar never resolved (→ OPENED → slow AI).
          const headers: { el: HTMLElement; key: string }[] = [];
          const seenHdr = new Set<HTMLElement>();
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          let tnode: Node | null;
          while ((tnode = walker.nextNode())) {
            const t = cleanHdr(tnode.nodeValue || "");
            if (!t || t.length > 24) continue;
            if (!/^[a-zà-ÿ.]+\.?\s+\d{4}$/i.test(t)) continue;
            const key = headerKey(t);
            const parent = tnode.parentElement;
            if (!key || !parent || seenHdr.has(parent) || !isVisible(parent))
              continue;
            seenHdr.add(parent);
            headers.push({ el: parent, key });
          }
          if (headers.length === 0) return null;
          // A cell matches the day when its text is EITHER exactly the day
          // number (clean leaf, "16") OR starts with the day followed by a
          // price (Streamsong/quick18 mash the price into the cell: "5$295").
          // Skip sold-out/unavailable cells outright.
          const SOLD_OUT = /sold\s*out|unavailable|not\s*available|\bn\/a\b/i;
          const matchesDay = (raw: string): boolean => {
            const t = raw.trim();
            if (!t || t.length > 30) return false;
            if (t === wantDay) return true;
            const first = t.match(/^(\d{1,2})(?=\D|$)/)?.[1];
            return first === wantDay && /[$€£]\s?\d/.test(t);
          };
          // Candidate day cells anywhere in the calendar.
          const cands = Array.from(
            document.querySelectorAll<HTMLElement>(
              "td,button,a,[role=gridcell],[role=button],li,span,div",
            ),
          ).filter(
            (el) =>
              isVisible(el) &&
              !looksDisabled(el) &&
              !SOLD_OUT.test(el.textContent || "") &&
              matchesDay(el.textContent || ""),
          );
          if (cands.length === 0) return null;
          // For a DUAL-MONTH calendar the same day appears twice. Disambiguate
          // by document order: pick the candidate whose NEAREST PRECEDING month
          // header is the target month.
          const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
          const nearestKey = (cell: HTMLElement): string | null => {
            let best: { el: HTMLElement; key: string } | null = null;
            for (const h of headers) {
              // h precedes (or contains) the cell in document order.
              if (h.el.compareDocumentPosition(cell) & FOLLOWING) best = h;
            }
            return best ? best.key : null;
          };
          for (const cell of cands) {
            if (nearestKey(cell) === targetKey) {
              return (
                cell.closest<HTMLElement>(
                  "td,button,a,[role=gridcell],[role=button],li",
                ) || cell
              );
            }
          }
          // Single-month calendar (only one candidate, section match unclear).
          if (cands.length === 1) {
            return (
              cands[0].closest<HTMLElement>(
                "td,button,a,[role=gridcell],[role=button],li",
              ) || cands[0]
            );
          }
          return null;
        };

        const findCell = (iso: string): HTMLElement | null =>
          findCellByMeta(iso) || findCellByText(iso);

        // ── Strategy 1: type into writable check-in / check-out inputs ────
        const setNative = (el: HTMLInputElement, val: string): void => {
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          desc?.set?.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        };
        const fieldHay = (el: Element): string =>
          (
            (el.getAttribute("placeholder") || "") + " " +
            (el.getAttribute("aria-label") || "") + " " +
            (el.getAttribute("name") || "") + " " +
            (el.getAttribute("id") || "") + " " +
            (el.getAttribute("data-testid") || "")
          ).toLowerCase();
        const typeInto = (iso: string, kind: "in" | "out"): boolean => {
          const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
          const dd = String(d).padStart(2, "0");
          const mm = String(m).padStart(2, "0");
          const want =
            kind === "in"
              ? [
                  "check-in", "check in", "checkin", "arrival", "arrive",
                  "from", "date", "data", "giorno", "fecha", "datum",
                  "when", "play", "tee",
                  // car-rental pick-up
                  "pick-up", "pickup", "pick up", "collection", "ritiro",
                ]
              : [
                  "check-out", "check out", "checkout", "departure", "depart",
                  "to",
                  // car-rental drop-off
                  "drop-off", "dropoff", "drop off", "return", "riconsegna",
                ];
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>("input"),
          );
          for (const el of inputs) {
            if (!isVisible(el)) continue;
            if (el.readOnly || el.disabled) continue;
            const type = (el.getAttribute("type") || "text").toLowerCase();
            if (!["text", "date", "tel", "search", ""].includes(type)) continue;
            const hay = fieldHay(el);
            if (!want.some((w) => hay.includes(w))) continue;
            // Respect the input's own format if it's a native date input.
            const val = type === "date" ? iso : `${mm}/${dd}/${y}`;
            setNative(el, val);
            return true;
          }
          return false;
        };

        // Arm a closed calendar by clicking the arrival field/label/box.
        const openCalendar = (): boolean => {
          const want = [
            "check-in", "check in", "checkin", "arrival", "arrive",
            "select dates", "select your dates", "choose dates", "dates",
            "add dates",
          ];
          const els = Array.from(
            document.querySelectorAll<HTMLElement>(
              "input,[role=textbox],button,[role=button],label,[class*=date],[class*=Date]",
            ),
          );
          for (const el of els) {
            if (!isVisible(el)) continue;
            const hay =
              fieldHay(el) + " " + (el.textContent || "").slice(0, 40).toLowerCase();
            if (want.some((w) => hay.includes(w))) {
              el.click();
              return true;
            }
          }
          return false;
        };

        // ── Checkout-only pass (ci omitted) ──────────────────────────────
        if (ci == null) {
          if (co == null) return null;
          if (typeInto(co, "out")) return `out=${co}`;
          const outCell = findCell(co);
          if (outCell) {
            outCell.click();
            return `out=${co}`;
          }
          return null;
        }

        // ── Full pass: typing first (most reliable), then cells ───────────
        // co == null is the SINGLE-DATE case (golf tee time): set only the one
        // date, no departure. Otherwise it's a stay range (check-in/out).
        if (typeInto(ci, "in")) {
          if (co == null) return `in=${ci}`;
          const typedOut = typeInto(co, "out");
          return `in=${ci}${typedOut ? ` out=${co}` : " out=PENDING"}`;
        }

        const inCell = findCell(ci);
        if (!inCell) {
          // Calendar likely isn't open yet — arm it and let the poll retry.
          return openCalendar() ? "OPENED" : null;
        }
        inCell.click();
        if (co == null) return `in=${ci}`;
        // Departure often only becomes selectable after arrival is set; if it
        // doesn't land this pass, the caller runs a checkout-only pass next.
        const outCell = findCell(co);
        if (outCell) outCell.click();
        return `in=${ci}${outCell ? ` out=${co}` : " out=PENDING"}`;
      },
      { ci: checkinISO, co: checkoutISO },
    );
  } catch {
    return null;
  }
}

/**
 * DIAGNOSTIC: when the deterministic date-setter can't find the calendar (it
 * returns OPENED and the slow AI takes over), dump WHAT THE PAGE ACTUALLY HAS
 * so we can fix the recognizer precisely instead of guessing at the DOM. Logs
 * once per run. Reports: iframes, shadow roots, month-header text nodes (+
 * samples), day-number candidates (+ samples), date-bearing aria-labels (+
 * samples), and the custom-element tags present (SynXis = sb-express, etc.).
 */
async function diagnoseCalendar(page: unknown): Promise<string> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return "(no evaluate)";
  try {
    return await cdp.evaluate<string>(() => {
      const MONTHS =
        "january february march april may june july august september october november december";
      const visible = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects?.();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // Month-header text nodes (loose: a month word + a 20xx year).
      const headerSamples: string[] = [];
      let headerCount = 0;
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let tn: Node | null;
      while ((tn = walker.nextNode())) {
        const t = (tn.nodeValue || "").replace(/\s+/g, " ").trim();
        if (t.length > 30) continue;
        const low = t.toLowerCase();
        if (!/\b20\d{2}\b/.test(low)) continue;
        if (!MONTHS.split(" ").some((m) => low.includes(m.slice(0, 3))))
          continue;
        headerCount++;
        if (headerSamples.length < 5)
          headerSamples.push(
            `"${t}"<${(tn.parentElement?.tagName || "?").toLowerCase()}>`,
          );
      }
      // Day-number candidates: short visible elements whose text starts with a
      // 1-2 digit day.
      const dayEls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "td,button,a,[role=gridcell],[role=button],li,span,div",
        ),
      ).filter((el) => {
        if (!visible(el)) return false;
        const t = (el.textContent || "").trim();
        return t.length > 0 && t.length <= 20 && /^\d{1,2}(\D|$)/.test(t);
      });
      const daySamples = dayEls
        .slice(0, 8)
        .map(
          (el) =>
            `"${(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 16)}"<${el.tagName.toLowerCase()}${
              el.getAttribute("aria-label")
                ? ` al="${el.getAttribute("aria-label")!.slice(0, 24)}"`
                : ""
            }>`,
        );
      // Elements carrying a 2026 date in aria-label / title / data-date.
      const metaEls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[aria-label],[title],[data-date],[data-day]",
        ),
      ).filter((el) => {
        const m = (
          (el.getAttribute("aria-label") || "") +
          (el.getAttribute("title") || "") +
          (el.getAttribute("data-date") || "") +
          (el.getAttribute("data-day") || "")
        ).toLowerCase();
        return /20\d{2}|\d{4}-\d{2}-\d{2}/.test(m);
      });
      const metaSamples = metaEls
        .slice(0, 5)
        .map((el) => {
          const a =
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.getAttribute("data-date") ||
            el.getAttribute("data-day") ||
            "";
          return `<${el.tagName.toLowerCase()} "${a.slice(0, 32)}">`;
        });
      // Shadow roots + custom-element tags (SynXis = sb-express).
      let shadowCount = 0;
      const customTags = new Set<string>();
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if ((el as HTMLElement).shadowRoot) shadowCount++;
        const tag = el.tagName.toLowerCase();
        if (tag.includes("-")) customTags.add(tag);
      }
      // THE GOLDMINE: the actual HTML of the calendar region. Find the densest
      // cluster of day cells (the common ancestor of the day candidates) and
      // dump its markup — that shows EXACTLY how this engine encodes a day, so
      // the recognizer can be fixed precisely instead of guessed. Truncated +
      // whitespace-collapsed so it fits one log line.
      let calendarHTML = "(none)";
      if (dayEls.length >= 5) {
        // Walk up from a middle day cell a few levels to a container that holds
        // many day candidates — that's the month grid.
        let node: HTMLElement | null = dayEls[Math.floor(dayEls.length / 2)];
        let best: HTMLElement | null = node;
        for (let i = 0; i < 6 && node?.parentElement; i++) {
          node = node.parentElement;
          const here = dayEls.filter((d) => node!.contains(d)).length;
          if (here >= Math.min(14, dayEls.length)) {
            best = node;
            break;
          }
          best = node;
        }
        if (best) {
          calendarHTML = (best.outerHTML || "")
            .replace(/\s+/g, " ")
            .replace(/> </g, "><")
            .slice(0, 2200);
        }
      }
      return [
        `iframes=${document.querySelectorAll("iframe").length}`,
        `shadowRoots=${shadowCount}`,
        `headerNodes=${headerCount} ${headerSamples.join(" ") || "(none)"}`,
        `dayCands=${dayEls.length} ${daySamples.join(" ") || "(none)"}`,
        `dateMeta=${metaEls.length} ${metaSamples.join(" ") || "(none)"}`,
        `customTags=${Array.from(customTags).slice(0, 12).join(",") || "(none)"}`,
        `\n  calendarHTML=${calendarHTML}`,
      ].join(" | ");
    });
  } catch (e) {
    return `(diag failed: ${e instanceof Error ? e.message : e})`;
  }
}

/**
 * Click the tee-time SLOT nearest the requested time — zero LLM. Golf booking
 * widgets (ForeUp, Chronogolf, TeeQuest) render the available times as a list
 * of clickable cards/rows ("6:00pm · 4 Players · $125"); the agent's only job
 * there is to click one, but a real run sat on a full ForeUp list the whole
 * time budget. This finds the slot cards, parses each card's time, picks the
 * one nearest the requested time (or the earliest if unknown), and clicks it.
 * Returns "slot=<minutes>" on a click, or null when no slot list is present.
 * Best-effort — never throws.
 */
/**
 * Click a golf "Search Tee Times" / "Find Times" button — zero LLM. Many golf
 * tee sheets (quick18, ForeUp, Teesnap) show a SEARCH FORM (date/course/players)
 * first; the tee-time list only renders AFTER you submit it. A real run filled
 * the form on Grayhawk's quick18 page but never hit "SEARCH TEE TIMES", so the
 * slot list never appeared and the slot-picker had nothing to click. This
 * submits the search. Returns the button label clicked, or null.
 */
/**
 * Cheap (DOM-only) check: is a credit-card NUMBER field on the page? This is
 * the "we've reached the card step — stop driving, hand to the payment flow"
 * signal for the deterministic conductor, without the LLM extract that
 * detectPaymentStep uses.
 */
async function detectCardFieldPresent(page: unknown): Promise<boolean> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return false;
  try {
    return await cdp.evaluate<boolean>(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
      return inputs.some((el) => {
        const r = el.getClientRects();
        if (!r || r.length === 0) return false;
        const m = [
          el.getAttribute("autocomplete"),
          el.name,
          el.id,
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          el.getAttribute("autocomplete") === "cc-number" ||
          /cc-?number|card.?number|cardnumber|credit.?card|\bpan\b/.test(m)
        );
      });
    });
  } catch {
    return false;
  }
}

/**
 * Click the button that ADVANCES to the next step — Search / Check Rates /
 * Continue / Next / Proceed — by meaning, on any layout. Deliberately EXCLUDES
 * the final commit verbs (Book / Reserve / Pay / Confirm / Complete) and never
 * fires when a card field is present, so the conductor can move through a form
 * without ever committing the booking. Returns the label clicked, or null.
 */
async function clickAdvanceButtonDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      // Never advance from the card step.
      const cardField = Array.from(
        document.querySelectorAll<HTMLInputElement>("input"),
      ).some((el) => {
        const m = [
          el.getAttribute("autocomplete"),
          el.name,
          el.id,
          el.getAttribute("placeholder"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          el.getAttribute("autocomplete") === "cc-number" ||
          /cc-?number|card.?number|cardnumber/.test(m)
        );
      });
      if (cardField) return null;
      const ADV =
        /^(search( tee times?| availability| rates?)?|check (rates?|availability)|find( tee)? times?|continue|next|proceed|select rate to continue|continue to (guest|details|checkout|payment)|go to checkout|review|view rates?|update search)$/i;
      const isOk = (el: HTMLElement): boolean => {
        const r = el.getClientRects();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el);
        if (s.visibility === "hidden" || s.display === "none") return false;
        if ((el as HTMLButtonElement).disabled) return false;
        if (el.getAttribute("aria-disabled") === "true") return false;
        return true;
      };
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button,[role=button],a,input[type=submit],input[type=button]",
        ),
      );
      for (const el of nodes) {
        const raw =
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          "";
        const txt = raw
          .trim()
          .replace(/^[\s›»→⟶▶‹«←◀<>·•|]+|[\s›»→⟶▶‹«←◀<>·•|]+$/g, "")
          .trim();
        if (!txt || txt.length > 30) continue;
        if (ADV.test(txt) && isOk(el)) {
          if (el instanceof HTMLAnchorElement) el.target = "_self";
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

/**
 * Blow through a hotel ENHANCEMENTS / upsell step in ONE click — zero LLM.
 * After the room/rate, luxury engines (Aman, SHR, Marriott) interpose an
 * "Enhancements / Enhance your stay" page of add-ons (spa, breakfast,
 * transfers, ski butler). You don't need to select anything — just continue.
 * A real Aman run spent 330s / ~25 AI steps grinding this page and then hit
 * the time cap 2s from the card step. This detects that we're ON an upsell
 * step (its heading/step-indicator is unmistakable) and clicks the forward
 * button — but ONLY there, so it can't skip the date or room step. Never fires
 * on the card step. Returns the button label, or null.
 */
async function clickThroughUpsellDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const r = (el as HTMLElement).getClientRects();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // Bail on the card step — never advance past payment.
      const hasCard = Array.from(
        document.querySelectorAll<HTMLInputElement>("input"),
      ).some((el) => {
        const m = [
          el.getAttribute("autocomplete"),
          el.name,
          el.id,
          el.getAttribute("placeholder"),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /cc-?number|card.?number|cardnumber/.test(m);
      });
      if (hasCard) return null;
      // Are we actually on an enhancements/upsell step? Look for its heading
      // or an active step-indicator — short, unmistakable text only.
      const UPSELL =
        /^(enhancements?|enhance your stay|enhance your experience|add-?ons?|extras|upgrade your stay|personali[sz]e your stay|make it special|optional extras|enrich your stay|protections?|coverage|protection options?|protections?\s*(&|and)\s*extras|extras?\s*(&|and)\s*(options|protection)|optional (services|extras|protection)|additional (options|services|drivers?)|cover options?|add (extras|protection)|your extras)$/i;
      const onUpsell = Array.from(
        document.querySelectorAll<HTMLElement>(
          "h1,h2,h3,h4,[class*=step],[class*=Step],[aria-current],li,span",
        ),
      ).some((el) => {
        if (!isVisible(el)) return false;
        const t = (el.textContent || "").trim();
        return t.length <= 30 && UPSELL.test(t);
      });
      if (!onUpsell) return null;
      // Click the forward button. Prefer an explicit skip/no-thanks, else the
      // generic Continue/Next/Proceed — never an "Add"/"Select" upsell button.
      const FORWARD =
        /^(no thanks?|skip|skip this( step)?|skip extras|not now|maybe later|decline|decline all|no extras|continue without (extras|protection)?|continue( to .*)?|next|proceed( to .*)?|review( & continue)?|continue to (guest|details|checkout|payment|driver)|go to (checkout|payment)|done)$/i;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button,[role=button],a,input[type=submit],input[type=button]",
        ),
      );
      // Two passes: skip/no-thanks first, then the generic continue verbs.
      for (const skipFirst of [true, false]) {
        for (const el of nodes) {
          const raw =
            el.innerText ||
            el.textContent ||
            (el as HTMLInputElement).value ||
            el.getAttribute("aria-label") ||
            "";
          const txt = raw
            .trim()
            .replace(/^[\s›»→⟶▶‹«←◀<>·•|]+|[\s›»→⟶▶‹«←◀<>·•|]+$/g, "")
            .trim();
          if (!txt || txt.length > 30) continue;
          if (!FORWARD.test(txt)) continue;
          const isSkip =
            /^(no thanks?|skip|not now|maybe later|decline|no extras|continue without)/i.test(
              txt,
            );
          if (skipFirst !== isSkip) continue;
          const s = window.getComputedStyle(el);
          if (
            !isVisible(el) ||
            (el as HTMLButtonElement).disabled ||
            el.getAttribute("aria-disabled") === "true" ||
            s.pointerEvents === "none"
          )
            continue;
          if (el instanceof HTMLAnchorElement) el.target = "_self";
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

async function clickGolfSearchDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const RE =
        /^(search tee times?|search times?|find tee times?|find times?|search availability|check availability|view tee times?|show tee times?|get tee times?|search|find|go)$/i;
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const r = (el as HTMLElement).getClientRects();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return (
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          Number(s.opacity || "1") > 0.05
        );
      };
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, [role=button], a, input[type=button], input[type=submit]",
        ),
      );
      for (const el of nodes) {
        const txt = (
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          ""
        ).trim();
        if (!txt || txt.length > 30) continue;
        if (RE.test(txt) && isVisible(el)) {
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

async function clickTeeTimeSlotDeterministically(
  page: unknown,
  requestedLabel: string | null,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(
      (arg: unknown) => {
        const { reqLabel } = arg as { reqLabel: string | null };
        // Parse the FIRST clock time in a string → minutes since midnight.
        const parseMin = (s: string): number | null => {
          const m = s.match(/\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i);
          if (!m) return null;
          let h = parseInt(m[1], 10);
          const min = parseInt(m[2], 10);
          if (h > 23 || min > 59) return null;
          const ap = (m[3] || "").toLowerCase().replace(/\./g, "");
          if (ap === "pm" && h !== 12) h += 12;
          if (ap === "am" && h === 12) h = 0;
          return h * 60 + min;
        };
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return (
            st.visibility !== "hidden" &&
            st.display !== "none" &&
            Number(st.opacity || "1") > 0.05 &&
            st.pointerEvents !== "none"
          );
        };
        const want = reqLabel ? parseMin(reqLabel) : null;
        // Find the best thing to CLICK for a tee-time card, given the element
        // that holds the time text. Three tiers, most-specific first:
        //   1) the nearest clickable ancestor (a/button/role=button, or a
        //      cursor:pointer card — ForeUp's slot is a pointer DIV).
        //   2) the card boundary (nearest ancestor that also shows a price or a
        //      Book/Reserve word) — and inside it, a Book/Reserve/Select button
        //      if one exists (Access/golfwithaccess renders a button per slot).
        //   3) the time element itself (a delegated React handler on a parent
        //      still fires when the inner element bubbles the click).
        const clickTarget = (timeEl: HTMLElement): HTMLElement => {
          let cur: HTMLElement | null = timeEl;
          for (let i = 0; i < 6 && cur; i++) {
            const cs = window.getComputedStyle(cur);
            if (
              cur.tagName === "A" ||
              cur.tagName === "BUTTON" ||
              cur.getAttribute("role") === "button" ||
              cs.cursor === "pointer"
            ) {
              return cur;
            }
            cur = cur.parentElement;
          }
          cur = timeEl;
          for (let i = 0; i < 6 && cur; i++) {
            const t = cur.textContent || "";
            if (t.length < 200 && /\$\s?\d|book|reserve|select|tee/i.test(t)) {
              const btn = cur.querySelector<HTMLElement>(
                "a,button,[role=button]",
              );
              if (btn && isVisible(btn)) return btn;
              return cur;
            }
            cur = cur.parentElement;
          }
          return timeEl;
        };
        // Candidate slot cards: smallish elements whose text carries a time.
        // The length guard keeps us to a single card ("6:00pm Aspen Golf Club
        // Front 4 Players $125.00"), never the whole page.
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            "a,button,[role=button],li,tr,div,span",
          ),
        );
        const slots: { el: HTMLElement; min: number }[] = [];
        const seen = new Set<HTMLElement>();
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          const txt = (el.textContent || "").trim();
          if (!txt || txt.length > 140) continue;
          const min = parseMin(txt);
          if (min == null) continue;
          const target = clickTarget(el);
          if (seen.has(target)) continue;
          seen.add(target);
          slots.push({ el: target, min });
        }
        if (slots.length === 0) return null;
        slots.sort((a, b) =>
          want != null
            ? Math.abs(a.min - want) - Math.abs(b.min - want)
            : a.min - b.min,
        );
        slots[0].el.click();
        return `slot=${slots[0].min}`;
      },
      { reqLabel: requestedLabel },
    );
  } catch {
    return null;
  }
}

/**
 * Pick the cheapest ROOM on a hotel rooms/suites list — zero LLM. Hotels show
 * a grid of room cards each with a CTA (Select / Book / Reserve / View Rates /
 * View Room Details); the agent's job is just to click one, but a real Hôtel
 * Martinez run SAT on the rooms list. This finds the room cards, prefers a
 * booking-forward CTA over an info-only one, picks the cheapest priced card
 * (or the first if no prices show), and clicks it. Best-effort — never throws.
 */
async function clickCheapestRoomDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // CALENDAR-STEP GUARD: never pick a "room" while the date picker is still
      // on screen. Aman's calendar cells carry PRICES ("11 €5838"), so a priced
      // cell could masquerade as a room — bail if a date-selection calendar is
      // present (its title/legend is unmistakable). This replaces the old
      // datesConfirmed gate, which wrongly stayed false (and disabled the room
      // picker for the whole run) whenever the AGENT set the dates itself.
      const onCalendarStep = Array.from(
        document.querySelectorAll<HTMLElement>("*"),
      ).some((el) => {
        if (!isVisible(el)) return false;
        const t = (el.textContent || "").trim();
        if (t.length > 60) return false;
        return /^(select your dates|choose your dates|minimum stay required|no availability)$/i.test(
          t,
        );
      });
      if (onCalendarStep) return null;
      const priceOf = (s: string): number | null => {
        const m = s.match(/[$€£]\s?([\d,]+(?:\.\d{1,2})?)/);
        return m ? parseFloat(m[1].replace(/,/g, "")) : null;
      };
      // Booking-forward CTAs rank higher than info-only "view details".
      const BOOK_CTA =
        /^(select( room)?|book( now| this room| this)?|reserve( now| this room)?|choose( room)?|view rates?|view offers?|see rates?|view deal|select rate|book room)$/i;
      const INFO_CTA = /^(view room details?|view details?|room details?|details)$/i;
      const labelOf = (el: HTMLElement): string =>
        (
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          ""
        ).trim();
      const ctaEls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "a,button,[role=button],input[type=button],input[type=submit]",
        ),
      ).filter((el) => {
        if (!isVisible(el)) return false;
        const t = labelOf(el);
        return t.length <= 24 && (BOOK_CTA.test(t) || INFO_CTA.test(t));
      });
      if (ctaEls.length === 0) return null;
      // Climb to the room CARD (nearest ancestor that mentions a room word or
      // shows a price, and isn't the whole page).
      const cardOf = (el: HTMLElement): HTMLElement => {
        let cur: HTMLElement | null = el;
        for (let i = 0; i < 6 && cur?.parentElement; i++) {
          cur = cur.parentElement;
          const t = cur.textContent || "";
          if (
            t.length < 400 &&
            (priceOf(t) != null ||
              /\b(suite|room|king|queen|deluxe|standard|superior|junior|villa|cabana)\b/i.test(
                t,
              ))
          ) {
            return cur;
          }
        }
        return el.parentElement || el;
      };
      const seen = new Set<HTMLElement>();
      const rooms: { cta: HTMLElement; price: number | null; book: boolean }[] = [];
      for (const cta of ctaEls) {
        const card = cardOf(cta);
        if (seen.has(card)) continue;
        seen.add(card);
        // Within this card prefer a booking-forward CTA over an info link.
        const ctas = Array.from(
          card.querySelectorAll<HTMLElement>(
            "a,button,[role=button],input[type=button],input[type=submit]",
          ),
        ).filter((e) => isVisible(e) && labelOf(e).length <= 24);
        const booking = ctas.find((e) => BOOK_CTA.test(labelOf(e)));
        const chosen = booking || cta;
        rooms.push({
          cta: chosen,
          price: priceOf(card.textContent || ""),
          book: !!booking,
        });
      }
      // Require a real PRICE on the room. A priceless "room" is almost always
      // a false match on a non-room page (a calendar cell, a nav tab) — that's
      // the "room=first" phantom that clicked the wrong thing on Aman. A real
      // room list shows "from $X/night", so demand one.
      const priced = rooms.filter((r) => r.price != null);
      if (priced.length === 0) return null;
      priced.sort((a, b) => {
        const pa = a.price ?? Infinity;
        const pb = b.price ?? Infinity;
        if (pa !== pb) return pa - pb;
        return (b.book ? 1 : 0) - (a.book ? 1 : 0);
      });
      priced[0].cta.click();
      return `room=$${priced[0].price}`;
    });
  } catch {
    return null;
  }
}

/**
 * Select the cheapest PUBLIC rate on a "Choose your rate" step — zero LLM.
 * Golf checkouts (Access/golfwithaccess, GolfNow) gate the Continue button
 * behind a rate choice; a real Troon run sat here twice because it never
 * selected the rate. Handles BOTH real <input radio>/[role=radio] AND custom
 * styled rate CARDS (Access renders a clickable card with a decorative circle,
 * not a real radio). Picks the cheapest NON-membership option (skips
 * "Premium+/Join/Member" upsells that need a paid account). Only clicks a rate
 * option — never a submit — so it can't advance the booking on its own.
 * No-ops if a rate is already selected. Returns what it picked, or null.
 */
async function selectCheapestRateRadioDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      const priceOf = (s: string): number | null => {
        const m = s.match(/[$€£]\s?([\d,]+(?:\.\d{1,2})?)/);
        return m ? parseFloat(m[1].replace(/,/g, "")) : null;
      };
      const MEMBERSHIP_RE =
        /premium\+?|membership|\bjoin\b|subscribe|member rate|loyalty|sign\s?up/i;

      type Opt = {
        click: HTMLElement;
        key: HTMLElement;
        text: string;
        price: number | null;
        membership: boolean;
        checked: boolean;
      };

      // ── Tier 1: real radios (INCLUDING hidden ones) ──────────────────
      // Styled radios hide the real <input> behind a decorative circle, so do
      // NOT filter by visibility — a hidden input's .click() still selects it.
      const radios = Array.from(
        document.querySelectorAll<HTMLElement>("input[type=radio], [role=radio]"),
      ).filter(
        (el) =>
          !(el as HTMLInputElement).disabled &&
          el.getAttribute("aria-disabled") !== "true",
      );
      let opts: Opt[] = radios.map((r) => {
        const label =
          (r.id && document.querySelector<HTMLElement>(`label[for="${CSS.escape(r.id)}"]`)) ||
          r.closest<HTMLElement>("label") ||
          r.closest<HTMLElement>("[class*=rate],[class*=option],[class*=Rate],li,tr") ||
          r.parentElement;
        const text = (label?.textContent || "").trim().slice(0, 200);
        return {
          click: r,
          key: r,
          text,
          price: priceOf(text),
          membership: MEMBERSHIP_RE.test(text),
          checked:
            (r as HTMLInputElement).checked ||
            r.getAttribute("aria-checked") === "true",
        };
      });

      // ── Tier 2: custom rate CARDS (no real radio) ────────────────────
      if (opts.length === 0) {
        const RATE_HINT =
          /\brate\b|public|standard|greens?\s*fee|guest|walking|riding|\d+\s*hole/i;
        const cards = Array.from(
          document.querySelectorAll<HTMLElement>(
            "div,li,button,a,[role=button],label",
          ),
        ).filter((el) => {
          if (!isVisible(el)) return false;
          const t = (el.textContent || "").trim();
          if (!t || t.length > 160) return false; // a single option, not the page
          if (priceOf(t) == null) return false;
          // Looks like a rate option: rate-ish words OR a radio-like circle.
          return (
            RATE_HINT.test(t) ||
            !!el.querySelector(
              "input[type=radio],[role=radio],[class*=radio],[class*=circle],[class*=Radio]",
            )
          );
        });
        // Dedupe nested cards: keep the SMALLEST (innermost) priced container.
        const kept: HTMLElement[] = [];
        for (const c of cards) {
          if (cards.some((o) => o !== c && c.contains(o))) continue; // has a smaller priced child
          kept.push(c);
        }
        opts = kept.map((c) => {
          const text = (c.textContent || "").trim().slice(0, 200);
          const circle = c.querySelector<HTMLElement>(
            "input[type=radio],[role=radio]",
          );
          // Prefer the actual radio CONTROL inside the card (real input or the
          // styled circle) over the card div — clicking the card text often
          // doesn't register the selection.
          const control =
            circle ||
            c.querySelector<HTMLElement>("[class*=radio i],[class*=circle i]") ||
            c;
          return {
            click: control,
            key: c,
            text,
            price: priceOf(text),
            membership: MEMBERSHIP_RE.test(text),
            checked:
              !!circle &&
              ((circle as HTMLInputElement).checked ||
                circle.getAttribute("aria-checked") === "true"),
          };
        });
      }

      if (opts.length === 0) return null;
      // Something already selected → leave it; the agent continues.
      if (opts.some((o) => o.checked)) return null;

      let pool = opts.filter((o) => o.price != null && !o.membership);
      if (pool.length === 0)
        pool = opts.filter(
          (o) => /public|standard|guest/i.test(o.text) && !o.membership,
        );
      if (pool.length === 0) pool = opts.filter((o) => !o.membership);
      if (pool.length === 0) pool = opts;
      pool.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      const choice = pool[0];
      // Click the control; for a real <input> also force checked + dispatch
      // change so React state updates even on a hidden input behind a label.
      choice.click.click();
      if (choice.click instanceof HTMLInputElement) {
        choice.click.checked = true;
        choice.click.dispatchEvent(new Event("input", { bubbles: true }));
        choice.click.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return `rate=${choice.price != null ? "$" + choice.price : choice.text.slice(0, 30)}`;
    });
  } catch {
    return null;
  }
}

/**
 * Deterministic guest-form autofill — zero LLM calls. Recognises standard
 * checkout fields by autocomplete/name/id/label and fills them with the
 * traveler's known values using native setters + synthetic input/change
 * events (so React/Angular forms register the values). Only touches VISIBLE,
 * EMPTY fields; never touches checkboxes (consent is the agent's call) or
 * card fields. Returns how many fields it filled. Best-effort, never throws.
 */
async function deterministicGuestFill(
  page: unknown,
  data: NonNullable<RunStagehandOptions["autofill"]>,
): Promise<number> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return 0;
  try {
    const result = await cdp.evaluate<number>(
      (arg: unknown) => {
        const d = arg as {
          firstName: string;
          lastName: string;
          email: string;
          phone: string;
          phoneNational: string;
          title: string;
          addressLine1?: string | null;
          city?: string | null;
          state?: string | null;
          postal?: string | null;
          countryName?: string | null;
        };
        let filled = 0;
        const visible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return st.visibility !== "hidden" && st.display !== "none";
        };
        const meta = (el: HTMLElement): string =>
          [
            el.getAttribute("autocomplete"),
            el.getAttribute("name"),
            el.id,
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            (el as HTMLInputElement).labels?.[0]?.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        const setVal = (el: HTMLInputElement, val: string) => {
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          desc?.set?.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          filled++;
        };
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=password]):not([type=submit]):not([type=button])',
          ),
        ).filter((el) => visible(el) && !el.value && !el.disabled && !el.readOnly);

        for (const el of inputs) {
          const m = meta(el);
          // NEVER touch payment fields.
          if (/card|cc-|cvc|cvv|expir|pan\b/.test(m)) continue;
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (/given-name|first.?name|\bfname\b/.test(m)) setVal(el, d.firstName);
          else if (/family-name|last.?name|surname|\blname\b/.test(m)) setVal(el, d.lastName);
          else if (/confirm.*(e-?mail)|(e-?mail).*(confirm|verify|repeat)/.test(m)) setVal(el, d.email);
          else if (type === "email" || /\be-?mail\b/.test(m)) setVal(el, d.email);
          else if (type === "tel" || /phone|mobile|\btel\b/.test(m)) {
            // Forms with a sibling country-code selector want national digits.
            const hasCountrySel = !!el.closest("div,fieldset")?.querySelector("select, [class*=country], [class*=flag]");
            setVal(el, hasCountrySel ? d.phoneNational : d.phone);
          } else if (d.addressLine1 && /address-line1|address.?(line)?.?1\b|street|\baddr/.test(m) && !/2|line.?2/.test(m)) setVal(el, d.addressLine1);
          else if (d.city && /\bcity\b|\btown\b|locality/.test(m)) setVal(el, d.city);
          else if (d.state && /state|province|region|county\b/.test(m) ) setVal(el, d.state);
          else if (d.postal && /\bzip\b|postal|postcode/.test(m)) setVal(el, d.postal);
          else if (/prefix|salutation|honorific|^title$|\btitle\b/.test(m) && /title|prefix|salutation/.test(m)) setVal(el, d.title);
        }

        // Selects: title / state / country.
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).filter(
          (el) => visible(el) && !el.disabled,
        );
        const pick = (el: HTMLSelectElement, want: string): boolean => {
          const w = want.toLowerCase();
          for (const opt of Array.from(el.options)) {
            const t = (opt.textContent || "").trim().toLowerCase();
            const v = (opt.value || "").toLowerCase();
            if (!t && !v) continue;
            if (t === w || v === w || t.startsWith(w) || (w.length > 3 && t.includes(w))) {
              if (el.value !== opt.value) {
                el.value = opt.value;
                el.dispatchEvent(new Event("change", { bubbles: true }));
                filled++;
              }
              return true;
            }
          }
          return false;
        };
        for (const el of selects) {
          const m = meta(el as unknown as HTMLElement);
          const unset = !el.value || /^(select|choose|--|please)/i.test(el.options[el.selectedIndex]?.textContent || "");
          if (!unset) continue;
          if (/title|prefix|salutation|honorific/.test(m)) pick(el, d.title.replace(".", "")) || pick(el, d.title);
          else if (d.countryName && /country/.test(m)) pick(el, d.countryName);
          else if (d.state && /state|province|region/.test(m)) pick(el, d.state);
        }
        return filled;
      },
      data as never,
    );
    return typeof result === "number" ? result : 0;
  } catch {
    return 0;
  }
}

/**
 * Detect a whole-page bot-wall on landing — CloudFront/Akamai/Cloudflare 403
 * "Request could not be satisfied" / "Access Denied" / "Attention Required".
 * Cheap single read; returns a short signal string when blocked, else null.
 */
async function detectBotBlock(page: unknown): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const title = (document.title || "").toLowerCase();
      const body = (document.body?.innerText || "").slice(0, 1500).toLowerCase();
      const hay = `${title} ${body}`;
      // Only short, error-shaped pages — a real booking page that happens to
      // mention "cloudflare" in a footer shouldn't trip this.
      if (body.length > 2500) return null;
      if (/request could not be satisfied|generated by cloudfront/.test(hay))
        return "cloudfront-403";
      if (/access denied|reference\s*#?\d{2}\.|akamai/.test(hay))
        return "akamai-block";
      // Hilton/Marriott Akamai block dressed up as a friendly error:
      // "Something went wrong … Reference No. 27.f9c…" / "maybe it's us…".
      if (
        /something went wrong/.test(hay) &&
        /reference\s*(no\.?|number|#|id)/.test(hay)
      )
        return "akamai-block";
      if (/maybe it.?s us.*maybe it.?s you/.test(hay)) return "akamai-block";
      if (/attention required|cloudflare|error 1020|ray id/.test(hay))
        return "cloudflare-block";
      if (/verify you are (a )?human|are you a human|unusual traffic|automated requests/.test(hay))
        return "human-check";
      if (/^403\b|\b403 error\b|\bforbidden\b|request blocked/.test(hay))
        return "403-blocked";
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Detect a browser-VERIFICATION wall (bot detection) — e.g. Access/
 * golfwithaccess at the login/checkout step shows "We were unable to verify
 * your browser." Reloading does NOT clear this (it's fingerprint/automation
 * detection), so we only DETECT it; the caller aborts for a stealth retry.
 */
async function detectVerifyWall(page: unknown): Promise<boolean> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return false;
  try {
    return await cdp.evaluate<boolean>(() => {
      const b = (document.body?.innerText || "").toLowerCase();
      return /unable to verify your browser|couldn.?t verify your browser|verify your browser.*(refresh|try again)/.test(
        b,
      );
    });
  } catch {
    return false;
  }
}

async function clickBookingEntryDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      // Already inside a booking engine? Don't touch anything.
      if (
        /reserv|book|rate|checkout|availability|search-results|ratelist/i.test(
          location.pathname + location.search + location.host,
        )
      ) {
        return null;
      }
      // PRIMARY: unambiguous booking-engine entries, incl. common variants
      // ("Reserve dates", "Book a stay") and the European booking verbs
      // (Buchen/Prenota/Réserver/Reservar). Deliberately EXCLUDED: "Plan
      // your trip" / "Request..." / "Enquire" — those are inquiry forms
      // (a human calls you back), not booking engines, and clicking them
      // wastes the run (Bandon Dunes). Unmatched wording falls through to
      // the agent, which reads any phrasing in any language.
      const PRIMARY =
        /^(book now|reserve now|book online|book your stay|book a stay|book a room|book your room|book your trip|book dates|reserve dates|reserve your stay|reserve a room|plan my stay|plan your stay|book accommodations? online|check availability|check rates|book a tee time|book tee times?|tee times? booking|book golf|book a round|book your round|golf booking|jetzt buchen|prenota ora|réservez?|reservar ahora)$/i;
      const SECONDARY =
        /^(reserve|reservations?|book|booking|tee times?|stay|buchen|prenota|réserver|reservar)$/i;
      // GOLF-ONLY deeper tier: a resort's golf page is often pure MARKETING
      // (One&Only "Experiences › Golf": hero + "About the Course / Pro Shop /
      // Lessons" cards, no booking widget). The tee sheet is one hop behind a
      // secondary link. We ONLY try these on a golf-context page so they can't
      // mis-fire on a hotel page (where "More info" means something else).
      // Ordered most-specific first; bare "more info" is the last resort.
      const GOLF_DEEPER =
        /^(book a tee time|tee times?|reserve a tee time|golf reservations?|about the course|view the course|the course|play golf|plan your game|more info|more information)$/i;
      const isGolfContext =
        /golf|tee[-\s]?time|fairway|links\b|clubhouse|pro\s*shop/i.test(
          location.pathname + location.search + " " + (document.title || ""),
        );
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rects = (el as HTMLElement).getClientRects();
        if (!rects || rects.length === 0) return false;
        const st = window.getComputedStyle(el as HTMLElement);
        return (
          st.visibility !== "hidden" &&
          st.display !== "none" &&
          Number(st.opacity || "1") > 0.05
        );
      };
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "a, button, [role=button], input[type=button], input[type=submit]",
        ),
      );
      const labelOf = (el: HTMLElement): string =>
        (
          el.innerText ||
          el.textContent ||
          (el as HTMLInputElement).value ||
          el.getAttribute("aria-label") ||
          ""
        )
          .trim()
          // Strip decorative arrows/chevrons that luxury sites append to CTAs
          // ("BOOK ›", "Reserve →") — they made the exact-match regex miss the
          // button (a real Hôtel du Cap run burned 40s hunting for "BOOK ›").
          .replace(/^[\s›»→⟶▶‹«←◀<>·•|]+|[\s›»→⟶▶‹«←◀<>·•|]+$/g, "")
          .trim();
      const tiers = isGolfContext
        ? [PRIMARY, SECONDARY, GOLF_DEEPER]
        : [PRIMARY, SECONDARY];
      for (const re of tiers) {
        for (const el of nodes) {
          const txt = labelOf(el);
          if (!txt || txt.length > 40) continue;
          if (re.test(txt) && isVisible(el)) {
            // Keep the navigation in THIS tab so the agent doesn't lose the
            // page (target=_blank booking links otherwise spawn a tab the
            // about-to-start agent isn't looking at).
            if (el instanceof HTMLAnchorElement) el.target = "_self";
            el.click();
            return txt;
          }
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

async function dismissConsentDeterministically(
  page: unknown,
  opts?: { safe?: boolean },
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(
      (arg: unknown) => {
        const safe = (arg as { safe?: boolean })?.safe === true;
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
      // PRIVACY POPUP WITH NO ACCEPT BUTTON (e.g. golfwithaccess's "We value
      // your privacy … Do Not Sell or Share", just an X). These intercept
      // clicks. Scope STRICTLY to a small banner that talks about cookies/
      // privacy so we never close a booking modal, then click its X / Close /
      // Reject control. Safe to run every step.
      const PRIV_RE =
        /we value your privacy|this (website|site) uses cookies|cookie|do not sell|gdpr|tracking technolog|privacy preferences/i;
      const CLOSE_RE =
        /^(×|✕|✖|x|close|dismiss|no thanks?|reject all|reject|decline|necessary only|only necessary|continue without|save (and )?close)$/i;
      const containers = Array.from(
        document.querySelectorAll<HTMLElement>(
          "div,section,aside,dialog,[role=dialog],[aria-modal=true]",
        ),
      );
      for (const c of containers) {
        if (!isVisible(c)) continue;
        const t = (c.textContent || "").trim();
        if (!t || t.length > 600) continue; // banners are short; skip the page
        if (!PRIV_RE.test(t)) continue;
        const ctrls = Array.from(
          c.querySelectorAll<HTMLElement>("button,[role=button],a,[aria-label]"),
        );
        for (const b of ctrls) {
          const lbl = (
            b.getAttribute("aria-label") ||
            b.innerText ||
            b.textContent ||
            ""
          ).trim();
          if (lbl && lbl.length <= 20 && CLOSE_RE.test(lbl) && isVisible(b)) {
            b.click();
            return `privacy-close:${lbl}`;
          }
        }
      }
      // The generic Accept/Agree/OK text scan can mis-click a booking
      // "Continue"/"OK" button, so only run it on the up-front (non-safe)
      // landing pass, never per-step.
      if (safe) return null;
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
      },
      { safe: opts?.safe === true },
    );
  } catch {
    return null;
  }
}

function progressLabel(step: number): string {
  // Specific + reassuring: the customer is watching a multi-minute run and
  // needs to know it's doing REAL work on the venue's own site, not hanging.
  if (step <= 1) return "Opening the venue's real booking site…";
  if (step <= 3) return "Checking live availability for your dates…";
  if (step <= 6) return "Picking your room/time and filling your details…";
  if (step <= 10) return "Working through the venue's checkout…";
  if (step <= 16) return "Confirming the booking on the venue's site…";
  return "Almost there — finalizing your reservation…";
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
  if (/enquiry[ _-]?sent|inquiry submitted|enquiry submitted|request (form )?submitted|reservation request (was )?sent/i.test(m))
    return "needs_review";
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
  | "enquiry_sent"
  | "ambiguous"
  | undefined {
  const m = (msg ?? "").toLowerCase();
  if (/enquiry[ _-]?sent|inquiry submitted|enquiry submitted|request (form )?submitted|reservation request (was )?sent/i.test(m))
    return "enquiry_sent";
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
