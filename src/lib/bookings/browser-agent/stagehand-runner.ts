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
import { detectGolfPlatform, golfPlatformAgentHint } from "../golf-platforms";
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
  /** Golf party size (number of players). ChronoGolf / ForeUp gate the
   *  tee-time list behind a "Players" step, so the deterministic Players
   *  picker needs the count to select it. null → leave the form default. */
  players?: number | null;
  /** Resort-guest golf: set when this tee time is at a resort the customer is
   *  staying at on the trip. `name` is the resort; `confirmationCode` is the
   *  stay's confirmation if it's booked (the agent enters it to book the golf
   *  as a guest), else null (stay not yet confirmed → link to it for the
   *  concierge). When set, the "are you a resort guest?" gate does NOT bail to
   *  a private-club dead end. null → not staying there → that course is private
   *  to the customer (the private/public-course path). */
  resortStay?: { name: string; confirmationCode: string | null } | null;
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
  /** MVP "review before charging": when true, the agent fills everything to the
   *  card step and STOPS there — no card minted, no money moved — returning a
   *  price_approval outcome with the real total for one-tap customer approval.
   *  The approve-price route lifts it (approvedPriceCents) and the re-run pays.
   *  Set per-booking (off once approved, off for pay-at-course golf). Env
   *  override BOOKING_REQUIRE_PAYMENT_REVIEW=false to go full-auto later. */
  requirePaymentReview?: boolean;
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
- INQUIRY / TRIP-PLANNER FORMS: "Plan My Trip", "Request a Quote", "Enquire Booking", "Request Information", "Contact Us", "Anfragen", "Richiesta" — forms that collect details so a HUMAN confirms later are INQUIRIES, not instant bookings. FIRST look for a real booking engine ("Book"/"Reserve"/"Tee Times" with live DATE fields) — that always wins. BUT if the venue genuinely offers ONLY an enquiry path (no live availability anywhere), DO THE CONCIERGE MOVE: fill the enquiry form with the full reservation request — dates, party size, the traveler's name/email/phone, and a short message ("Requesting [room/tee time] for [dates], [N] guests — please confirm availability to this email") — submit it ONCE, then report needs_review with reason "enquiry_sent", stating exactly what was requested. NEVER report an enquiry as confirmed — the venue confirms directly with the customer. If there is no enquiry form either (phone only), report failed / form_not_found with the phone number. SPEED: the big US golf RESORTS — Pebble Beach ("plan my trip" / "Reservation Inquiry"), Pinehurst, Bandon Dunes, Sea Island — book this way ONLY: there is no instant online checkout, just the inquiry. Recognize it on sight and be DECISIVE — your dates are auto-filled for you, so you only need to set the rooms + GUESTS/GOLFERS count to the party size (if it shows 0 it's a required field — set it), fill your contact details, and SUBMIT in a HANDFUL of steps. Do NOT keep hunting for a "book"/rate page that does not exist on these resorts, and do NOT re-read the page over and over — fill the highlighted required fields and submit. PREVIEW-ONLY / CALL-TO-BOOK (Bandon Dunes is exactly this): some resorts show a calendar you can only LOOK at — the day cells are NOT clickable, there's no rate/checkout, and the only real CTA is "speak to a representative" / "call to reserve" / a phone number. That is NOT a booking engine and NOT an inquiry form. The moment you realize the dates can't be selected and there's no form to submit, STOP within ~2-3 steps and report failed / form_not_found with the phone number — do NOT keep clicking the preview calendar or scrolling the page looking for a checkout that doesn't exist.
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
- GUIDED "PLANNER" / WIZARD flows (no calendar at all): some resorts (Hammock Beach) replace the calendar with a step-by-step wizard — "When do you want to travel?" with SEASON tiles (Summer / Fall / Winter / Spring) and "This week / Next week" buttons, then a property picker, then rooms. There are NO day cells to click. Navigate it like a human: pick the SEASON that contains your travel month (August → Summer, November → Fall, January → Winter, April → Spring); if it then offers a week/date range, pick the one closest to your target dates; then pick the property/resort named in the task and its room. Do NOT sit waiting for a calendar — work the wizard's buttons in order. If after picking season+week it lands on an actual date calendar, use it normally.
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
- When registration IS mandatory (a "Create an account" / "visitor registration"
  form with a Password + Repeat-password — ChronoGolf does this even for
  visitors): the system AUTO-FILLS the name/email/phone AND a strong password in
  BOTH password fields. Just tick any required terms checkbox and click Sign up /
  Register / Continue to create the account on the customer's behalf, then
  CONTINUE the booking to completion — registering is a STEP, not the end. Never
  stop at the signup screen, and never click "log in" (we have no existing
  account). If a password field is somehow still empty, type a strong 12+ char
  password (letters + a number + a symbol) into BOTH fields yourself and proceed.
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
- NEVER BOOK A HOTEL ROOM FOR A TEE TIME. If the only booking widget you can find on a golf page is the resort's ROOM reservation (nightly rates, Arrival/Departure, Adults/Children/Rooms, a multi-night stay calendar), that is NOT how you book golf — do NOT pick dates or rooms there. A tee time is a single date + players, never a multi-night stay.
- ALWAYS ATTEMPT THE GOLF BOOKING FIRST — "reservations by phone" is a LAST resort, NEVER a first guess. A clickable golf booking button — "BOOK A TEE TIME" / "CHECK AVAILABILITY" / "TEE TIMES" / "RESERVE" / "BOOK NOW" in a golf/tee-time context — is PROOF that online booking exists. You MUST click it and work through whatever opens (a course picker, then a date + players search, then a SLOT LIST — which FREQUENTLY renders inside an IFRAME / embedded widget, so wait a moment and look there before deciding it's empty). NEVER report form_not_found or members_only while such a button is still on the page unclicked — that is giving up without trying. Only fall back to phone when the page's ONLY booking path is a phone number / "call to reserve" / "members only" / "Pro Shop" text with NO interactive booking button anywhere.
- NO ONLINE TEE SHEET → report it FAST (within ~3-4 steps) — but ONLY once you've clicked any booking button per the rule above and confirmed there's genuinely no slot list. Don't grind for 20. MOST luxury resort courses do NOT book tee times online — they're members/guest-only and arranged by PHONE or the PRO SHOP. Bail immediately the moment the page shows ANY of: "reserved for resort guests and club members only" / "members only" / "call … to reserve" / "call for tee times" / "confirm … through the Golf Pro Shop" / "arranged through the Golf Club representative" / a Services/Golf-reservations section that only DESCRIBES the policy with no form or widget. Report failed / members_only (or form_not_found if simply phone/pro-shop only), quoting any phone number. Do NOT click the hotel "Check Availability" or book a room — there is nothing to book online. Only KEEP GOING if you find an actual interactive tee-time widget (a date + players search that returns clickable time slots, e.g. EZLinks/ForeUp/Chronogolf/GolfNow). If after a couple of clicks there's no such widget, conclude no online booking and stop — don't keep exploring menus.
- RESORT / MARKETING GOLF PAGE — DIG, DON'T GIVE UP. When you land on a golf page that's pure marketing (a hero photo + "About the Course / Pro Shop / Golf Lessons" cards + a "Check Availability" bar that's really the HOTEL's room widget — e.g. One&Only "Experiences › Golf"), the tee sheet is almost always ONE or TWO clicks deeper behind a secondary link. Do NOT report form_not_found after one look — LOOK HARD and click the most booking-like link, in this order: "BOOK A TEE TIME" / "TEE TIMES" / "RESERVE" → then "ABOUT THE COURSE" / "VIEW THE COURSE" / "MORE INFO" / "PLAN YOUR GAME" → then the COURSE'S OWN NAME as a link (resorts link out to the golf club's own site / tee sheet, often on a different domain — follow it). Follow ONE hop; if that page has a Book / Tee-time button or a date+players widget, use it. The "Check Availability" date bar on a golf marketing page is usually for HOTEL ROOMS, not golf — don't book a room when the task is a tee time; find the golf-specific booking link instead. Only after you've tried the booking links AND the course-name link and there's genuinely no online tee sheet (phone / concierge / "arranged through the Golf Shop" only) do you report form_not_found, quoting the phone/email.
- Many courses embed a booking widget (GolfNow, Lightspeed/Chronogolf, ForeUp, TeeQuest). That widget IS the real booking system — use it, even if the URL host changes.
- Set the DATE and number of PLAYERS (light thinking — you KNOW both from the task), then the slot list is a REFLEX: click the tee time at or nearest the requested time on the SAME step you see the grid — don't compare slots, don't re-read. Clicking the slot opens the form; batch-fill the player/contact details and book. If a card/deposit is required, STOP per rule 6.
- THE SPECIFIC COURSE IS A PREFERENCE, NOT A REQUIREMENT. Many clubs have MULTIPLE courses (Troon North = Monument + Pinnacle; Pebble, Bandon, Streamsong all have several). If the task names a course (e.g. "Monument Course") but that one has NO open tee times for the date, BOOK AN AVAILABLE TEE TIME AT ANOTHER COURSE AT THE SAME CLUB — the customer wants to play this CLUB; which of its courses is secondary. NEVER report "no availability" while other courses at the same facility have open slots (a real run found 58 tee times at Troon North, all Pinnacle, and wrongly quit because it wanted Monument). Clear/ignore the course filter, take ANY available course's nearest time, and book it. Only report no_availability when the WHOLE club has no tee times that day.
- NO SLOTS ON THE REQUESTED DATE → REPORT IT IMMEDIATELY, don't linger. The moment the slot list is EMPTY and the page says ANY of: "No tee times available" / "No tee times available matching your search criteria" / "no times found" / "fully booked" / "sold out" / a "next available date" hint, the course is simply full that day. STOP at once (within 1-2 reads) and report failed / no_availability — quote the message and the next-available date if shown. Do NOT re-search, do NOT sit on the page, do NOT try other times — an empty tee sheet won't fill by re-reading it. Reporting no_availability is what lets our system offer the customer a nearby alternative course; that hand-off only happens if you report it cleanly and fast instead of stalling.
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
  // STALL WATCHDOG handle (started just before agent.execute, cleared in the
  // finally). A time-based safety net: when the LLM agent stops completing
  // steps — it HANGS, doesn't error (Streamsong sat ~280s on the rooms/Book
  // step with no steps logged until the wall-clock) — the per-step
  // deterministic passes never fire either (they're keyed on onStepFinish), so
  // nothing pushes the booking forward and nothing captures WHERE it's stuck.
  // This drives the same conductor recognizers on a timer instead. GENERAL.
  let stallWatch: ReturnType<typeof setInterval> | null = null;
  // Declared at function scope (not inside the try) so the catch/finally can
  // read it — it gates the one-shot stuck-DOM dump across all exit paths.
  let stuckDiagged = false;
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
      // GOLF: never let the FIRST click grab a resort's room "Book Now" — on a
      // golf task off a golf page we only take an explicit golf CTA here; the
      // conductor's golf-section navigator drills into the tee sheet next.
      const entry = await clickBookingEntryDeterministically(page, {
        golf: !!opts.selectTeeSlot,
      });
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
    let inDateSet = false; // arrival cell clicked — chase departure checkout-only
    let slotAlreadyPicked = false;
    let golfSearchSubmitted = false;
    let rateSelected = false;
    let playersSet = false;
    // Anti-hammer for the per-step golf checkout-advance: GolfNow's "Search"
    // re-runs the search instead of advancing, so without a cap it clicked
    // ~15 times across a run. Stop after a few identical clicks.
    let golfAdvanceLabel = "";
    let golfAdvanceCount = 0;
    let golfAdvanceStuck = false;
    let roomPicked = false;
    // Luxury multi-service properties (Villa d'Este, many SynXis engines) open
    // a "What would you like to book?" chooser right after "Book now" — hotel /
    // villa / table / treatment / event — BEFORE the calendar. Pick the
    // rooms/stay option once so the flow proceeds instead of re-clicking "Book
    // now" and stalling on the chooser.
    let bookingTypeChosen = false;
    // ChronoGolf-style "Visitors | Members" tab — the customer is a public
    // visitor; make sure we're on the guest tab, not Members (member login).
    let visitorTabChosen = false;
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
    // One-shot: a collapsed guest form ("Add Guest") gets expanded at most once
    // per run (shared by the per-step pass + the stall-watchdog), so we never
    // add guest rows in a loop.
    let guestFormRevealed = false;
    // One-shot: on a single-page checkout (contact info + card on ONE page) fill
    // the contact fields the moment the card step is reached, before handing off.
    let cardStepFilled = false;
    // One-shot guard so the calendar diagnostic dumps at most once per run.
    let calendarDiagnosed = false;
    // One-shot PER HOST: dump the guest/checkout form's real field structure so
    // a driver can be built from the actual DOM, not screenshots. Re-fires when
    // the booking moves to a new host (e.g. streamsongresort.com → the embedded
    // spend.onagilysys.com engine) so we capture the REAL checkout form, not an
    // earlier inquiry form on the marketing site.
    let guestFormDiagnosed = false;
    let lastGuestDiagHost = "";
    // Cap on next-month hops, so an unreachable date can't spin forever.
    let monthAdvances = 0;
    // Anti-spam for the Advance ("Next"/"Continue") click: a real multi-step
    // form changes the button or the page each click, but a no-op button (a
    // photo-carousel arrow, a dead "Next") fires forever. Stop after a few
    // identical clicks — a Bandon run clicked "Next" 25× for 80s.
    let advanceLabel = "";
    let advanceRepeats = 0;
    let bookCtaLabel = "";
    let bookCtaRepeats = 0;
    // Golf-section navigation (resort landing page → Golf → Tee Times) state:
    // distinct labels are progress (Activities → Golf → Tee Times), repeats /
    // a hard cap stop a nav loop.
    let golfNavLabel = "";
    let golfNavRepeats = 0;
    let golfNavClicks = 0;
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
        // The calendar may live inside an IFRAME (Gleneagles/SynXis) — resolve
        // the booking frame each pass (it loads a beat after Book-Now) and click
        // the cells THERE; page-JS can't reach an iframe's calendar.
        let dctx: unknown = page;
        // Poll: the calendar appears a beat after the Book-Now navigation, and
        // a closed calendar needs one pass to ARM it (returns "OPENED") before
        // the cells exist to click. Keep going while we're still null/OPENED —
        // AND while it's still "ADVANCING": ADVANCING means the setter clicked
        // next-month to reach the target month but has NOT clicked the day yet,
        // so each ADVANCING pass moves one month and the loop must come back to
        // click the actual day. The old loop quit on the first ADVANCING and
        // (below) marked dates "complete" on a bare month-hop — so any date a
        // month+ out (most trips, and every ChronoGolf golf date) was never
        // clicked deterministically, dumping a half-set calendar to the slow
        // agent. Bounded to 10 passes: a normal target is ≤6 months out and
        // lands in a few passes; if it hasn't landed by 10 the calendar isn't
        // cracking deterministically (dual-iframe Pikaday) — stop polling (~10s)
        // and let the agent's month-first logic take it, rather than staring ~35s.
        for (
          let i = 0;
          i < 10 &&
          (!setDates || setDates === "OPENED" || setDates === "ADVANCING");
          i++
        ) {
          dctx = await bookingFrame(page);
          setDates = await clickStayDatesDeterministically(
            dctx,
            opts.checkinISO ?? null,
            opts.checkoutISO ?? null,
          );
          if (!setDates || setDates === "OPENED" || setDates === "ADVANCING") {
            await new Promise((r) => setTimeout(r, 900));
          }
        }
        // Arrival landed but the departure cell wasn't selectable yet (many
        // range pickers only enable check-out after check-in is chosen). Run
        // dedicated checkout-only passes (against the booking frame) so the
        // agent inherits a COMPLETE range and never touches the calendar.
        if (setDates && setDates.includes("out=PENDING")) {
          for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 1200));
            dctx = await bookingFrame(page);
            const outRes = await clickStayDatesDeterministically(
              dctx,
              null,
              opts.checkoutISO ?? null,
            );
            if (outRes && outRes.startsWith("out=")) {
              setDates = `in=${opts.checkinISO} out=${opts.checkoutISO}`;
              break;
            }
          }
        }
        // Checkout cell STILL won't resolve (Aman/Gleneagles SynXis) → dump the
        // calendar DOM once so the gridcell selector can be built from the real
        // markup. This is why a Gleneagles run never logged a calendar diag: it
        // only fired on "OPENED" before, never on out=PENDING.
        if (setDates && setDates.includes("out=PENDING") && !calendarDiagnosed) {
          calendarDiagnosed = true;
          const cdiag = await diagnoseCalendar(dctx).catch(() => "(diag failed)");
          console.log(`[stagehand] 🔬 calendar diag (out=PENDING) :: ${cdiag}`);
        }
        // Mark dates DONE only when the range is COMPLETE. On out=PENDING, leave
        // datesAlreadySet false (record inDateSet) so the frame-aware conductor
        // finishes the departure instead of advancing with half a range.
        if (setDates && setDates.startsWith("in=")) inDateSet = true;
        const rangeComplete =
          !!setDates &&
          setDates !== "OPENED" &&
          setDates !== "ADVANCING" &&
          !(opts.checkoutISO && setDates.includes("out=PENDING"));
        if (rangeComplete) {
          datesAlreadySet = true;
          datesConfirmed = true;
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
        // The tee sheet may live in an IFRAME (Gleneagles golf is the same
        // <booking-layout> iframe as the hotel side) — resolve the booking
        // frame and drive it THERE; page-JS can't see an iframe's slot list,
        // which is why a real run reported form_not_found ("reservations by
        // phone") on a course that DOES book online. Falls back to the page.
        let gctx: unknown = await bookingFrame(page);
        // Some tee sheets (quick18/Grayhawk, ForeUp) gate the slot list behind
        // a SEARCH FORM — submit it first so the slots actually render.
        const searched = await clickGolfSearchDeterministically(gctx);
        if (searched) {
          console.log(
            `[stagehand] ✓ golf search submitted ("${searched}") (${elapsed()})`,
          );
          golfSearchSubmitted = true;
          await new Promise((r) => setTimeout(r, 2000));
        }
        let picked: string | null = null;
        // Short poll: on engines where slots render right after a search (ForeUp)
        // this grabs the slot in ~1-2s. On engines that gate the list behind a
        // Players step (ChronoGolf), no slot exists yet — fail FAST (don't stare
        // ~9s here); the conductor sets Players then picks the slot itself.
        for (let i = 0; i < 2 && !picked; i++) {
          gctx = await bookingFrame(page);
          picked = await clickTeeTimeSlotDeterministically(
            gctx,
            opts.teeTimeLabel ?? null,
          );
          if (!picked) await new Promise((r) => setTimeout(r, 1000));
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
    let openedRepeats = 0;
    let bookingFrameLogged = false;
    try {
      const tick = async (): Promise<string | null> => {
        const pageCtx = stagehand.context.activePage() ?? page;
        if (!pageCtx) return null;
        await forceSingleTab(pageCtx);
        await dismissConsentDeterministically(pageCtx, { safe: true });
        // Close any blocking info/promo modal (Sea Island "Rate Availability"
        // popup, newsletter, welcome overlay) so it can't intercept clicks.
        // Heavily guarded — never closes a real booking step. GENERAL, every site.
        {
          const m = await dismissBlockingModalDeterministically(pageCtx);
          if (m) return `closed modal "${m}"`;
        }
        // The booking engine often loads INSIDE an iframe (Gleneagles/SynXis:
        // <booking-layout> → iframe). Page-JS is blind to iframe content, so
        // drive the CONTENT recognizers against the booking frame. Falls back to
        // the page for non-iframe sites (Aman-style SPA), which are unaffected.
        const bf = await bookingFrame(pageCtx);
        if (bf !== pageCtx && !bookingFrameLogged) {
          bookingFrameLogged = true;
          console.log(
            `[stagehand] 📦 booking engine is in an iframe — driving it directly (${elapsed()})`,
          );
        }
        // Close a blocking modal INSIDE the booking frame too (Sea Island's
        // "Rate Availability" popup lives in the iframe). Same strong guards.
        if (bf !== pageCtx) {
          const fm = await dismissBlockingModalDeterministically(bf);
          if (fm) return `closed modal "${fm}"`;
        }
        // Reached the card step → FILL any contact/guest fields still on this
        // page FIRST (autofill always skips the card field itself), THEN stop.
        // Single-page checkouts (Auberge/iHotelier) put Contact Info ABOVE the
        // card on the SAME page, and this card check runs before the autofill
        // step further down — so without this the conductor parks at the card
        // step with name/email/address blank (a real 42s Auberge run did exactly
        // that). One-shot + speed-neutral (~100ms fill, then it stops next tick).
        if (await detectCardFieldPresent(bf)) {
          if (opts.autofill && !cardStepFilled) {
            cardStepFilled = true;
            const n = await deterministicGuestFill(bf, opts.autofill).catch(() => 0);
            if (n > 0) {
              console.log(
                `[stagehand] ⚡ filled ${n} contact fields at the card step (${elapsed()})`,
              );
              return `card-step autofill ${n}`;
            }
            // Filled nothing but there's a card here, so a contact form likely
            // sits above it — dump its real structure once so a field-matching
            // miss is fixable from DOM (the conductor stops here, so the agent's
            // own guest-form diag never runs on this page).
            const gd = await diagnoseGuestForm(bf).catch(() => "");
            if (gd)
              console.log(`[stagehand] 🔬 card-step guest-form diag :: ${gd}`);
          }
          conductorReachedCard = true;
          return null;
        }
        // BOOKING-TYPE CHOOSER ("What would you like to book?" → hotel / villa /
        // table / treatment / event). Appears after "Book now", before the
        // calendar; pick the rooms/stay option so the flow proceeds instead of
        // the conductor re-clicking "Book now" and stalling. Self-guards to a
        // REAL chooser (≥2 booking-type options), so it can't mis-fire.
        if (!bookingTypeChosen) {
          const choice = await clickBookingTypeChooserDeterministically(bf);
          if (choice) {
            bookingTypeChosen = true;
            return `booking-type "${choice}"`;
          }
        }
        // VISITOR/GUEST tab (ChronoGolf "Visitors | Members") — the customer is
        // a public visitor; click the guest tab so we never land on Members
        // (member login). One-shot once we're confirmed on it.
        if (!visitorTabChosen) {
          const tab = await clickGuestTabDeterministically(bf);
          if (tab === "already-visitors") {
            visitorTabChosen = true;
          } else if (tab) {
            visitorTabChosen = true;
            return `guest-tab "${tab}"`;
          }
        }
        // GOLF: players → search → slot → rate.
        if (opts.selectTeeSlot) {
          // PLAYERS step first — ChronoGolf/ForeUp render NO tee times until the
          // party size is chosen, which is exactly where a real run stalled (the
          // conductor had a date + slot picker but nothing to set Players).
          // Gated on the date being confirmed so it can't expand before a day is
          // picked; the picker itself is position-scoped so it never grabs a
          // calendar number. "players-open" (accordion expand) isn't terminal —
          // keep going so the next tick selects the count.
          if (!playersSet && (datesConfirmed || !opts.checkinISO)) {
            const p = await setPlayersCountDeterministically(bf, opts.players ?? null);
            if (p) {
              if (p !== "players-open") playersSet = true;
              return `players ${p}`;
            }
          }
          if (!golfSearchSubmitted) {
            const s = await clickGolfSearchDeterministically(bf);
            if (s) { golfSearchSubmitted = true; return `golf-search "${s}"`; }
          }
          if (!slotAlreadyPicked) {
            const r = await clickTeeTimeSlotDeterministically(bf, opts.teeTimeLabel ?? null);
            if (r) { slotAlreadyPicked = true; return `slot ${r}`; }
          }
          if (!rateSelected) {
            const r = await selectCheapestRateRadioDeterministically(bf);
            if (r) { rateSelected = true; return `rate ${r}`; }
          }
        }
        // DATES FIRST (hotel + golf). Once arrival is in, run CHECKOUT-ONLY
        // passes so we don't re-click (and risk deselecting) the arrival cell
        // while chasing departure. "out=PENDING" is NOT done — keep going.
        if (opts.checkinISO && !datesAlreadySet) {
          const r =
            inDateSet && opts.checkoutISO
              ? await clickStayDatesDeterministically(bf, null, opts.checkoutISO)
              : await clickStayDatesDeterministically(bf, opts.checkinISO ?? null, opts.checkoutISO ?? null);
          // Un-settable calendar → dump its DOM once so we can fix it precisely.
          if (r === "OPENED" && !calendarDiagnosed) {
            calendarDiagnosed = true;
            const diag = await diagnoseCalendar(bf);
            console.log(`[stagehand] 🔬 calendar diag :: ${diag}`);
          }
          // Next-month arrow toward the target month is real progress — cap at
          // ~14 hops so an unreachable date can't spin forever.
          if (r === "ADVANCING") {
            monthAdvances += 1;
            // Bail to the agent after 7 hops with no match. On a normal calendar
            // the target is ≤6 months out and lands quickly; if we've clicked
            // "next" 7× and STILL haven't matched, the month-nav isn't converging
            // (dual-calendar / multi-iframe Pikaday like The Pearl) — the agent's
            // explicit month-first logic handles those better, so hand off rather
            // than flail (was 14, which sat ~30s on a calendar we can't crack).
            if (monthAdvances >= 7) {
              datesAlreadySet = true;
              return `dates give-up (advanced ${monthAdvances} months, no match)`;
            }
            return `dates advancing-month`;
          }
          // Departure landed (checkout-only pass) → range complete.
          if (r && r.startsWith("out=")) {
            datesAlreadySet = true;
            datesConfirmed = true;
            return `dates ${r}`;
          }
          if (r && r !== "OPENED" && r.startsWith("in=")) {
            inDateSet = true;
            // Complete only when departure is set too (single-date golf has none).
            if (!opts.checkoutISO || !r.includes("out=PENDING")) {
              datesAlreadySet = true;
              datesConfirmed = true;
              return `dates ${r}`;
            }
            // out=PENDING → keep chasing departure (checkout-only next tick).
            dateArmAttempts += 1;
            if (dateArmAttempts >= 6) { datesAlreadySet = true; return `dates give-up (out pending)`; }
            return `dates ${r}`;
          }
          // "OPENED" = the calendar is open but we couldn't resolve a clickable
          // day this pass. ONE open-click is legit progress; after that, repeated
          // OPENED is NOT progress (it was masquerading as an action, resetting
          // the stall counter, so a Pikaday calendar we couldn't read looped
          // "dates OPENED" ~28s before giving up). Cap it: after 2, return null
          // so it counts as a stall and hands to the agent fast.
          if (r === "OPENED") {
            openedRepeats += 1;
            if (openedRepeats <= 2) return `dates ${r}`;
            datesAlreadySet = true; // stop re-opening; let the agent finish dates
            return null;
          }
          if (r) {
            dateArmAttempts += 1;
            if (dateArmAttempts >= 6) datesAlreadySet = true; // give up → advance
            return `dates ${r}`;
          }
        }
        // HOTEL room / CAR vehicle → rate. ONLY after the dates are confirmed —
        // otherwise a stray priced element on the calendar/search step (a £160
        // add-on or spa line when the rooms are £750+) gets grabbed as the
        // "room" before search has even run, and the booking is then wedged
        // (Gleneagles did exactly this). datesConfirmed is now set by BOTH the
        // fast-path and the conductor whenever OUR code sets the dates, so this
        // gate no longer disables the picker the way it used to. GENERAL: every
        // hotel/car must search before there are real rooms to pick.
        if (pickCards && (datesConfirmed || !opts.checkinISO)) {
          if (!roomPicked) {
            const r = await clickCheapestRoomDeterministically(bf);
            if (r) { roomPicked = true; return `room ${r}`; }
          } else if (!rateCardPicked) {
            // SECOND priced list (rate plans with Reserve/Book buttons). Runs
            // on the NEXT tick after the room pick (the return above splits
            // them), so it can't re-click the room on the same DOM.
            const r = await clickCheapestRoomDeterministically(bf);
            if (r) { rateCardPicked = true; return `rate-card ${r}`; }
          }
          if (!rateSelected) {
            const r = await selectCheapestRateRadioDeterministically(bf);
            if (r) { rateSelected = true; return `rate ${r}`; }
          }
        }
        // ADD-ON / UPSELL step → continue past it in one click. Hotels
        // (enhancements), cars (protection/extras), golf (cart/club rental) all
        // interpose one; a real hotel run wasted 330s grinding it. Self-guards
        // to the upsell step, so it's safe for all three.
        if (skipUpsell) {
          const up = await clickThroughUpsellDeterministically(bf);
          if (up) return `upsell-skip "${up}"`;
        }
        // GUEST DETAILS autofill.
        if (opts.autofill) {
          if (!guestFormDiagnosed) {
            const gdiag = await diagnoseGuestForm(bf).catch(() => "");
            if (gdiag) {
              guestFormDiagnosed = true;
              console.log(`[stagehand] 🔬 guest-form diag :: ${gdiag}`);
            }
          }
          const n = await deterministicGuestFill(bf, opts.autofill);
          if (n > 0) return `autofill ${n} fields`;
        }
        // GOLF on a RESORT page: the tee sheet is usually buried behind the
        // resort's nav (Pinehurst/Gleneagles homepage → "Golf" → "Tee Times" →
        // the widget). The generic Book CTA can't help — on a resort homepage it
        // either finds nothing golf-y or grabs the HOTEL "Book Now". Since we
        // KNOW this is a golf booking, deterministically drill into the golf
        // section (tee-time link > Golf section > Activities), one hop per tick,
        // BEFORE the generic CTA — this is the "find the golf fast" path. Stops
        // the moment we're in a tee-sheet/calendar (the date/slot recognizers
        // take over). Distinct labels = progress; repeats / a cap stop a loop.
        if (opts.selectTeeSlot && bf === pageCtx && golfNavClicks < 5) {
          const gnav = await clickGolfSectionDeterministically(pageCtx);
          if (gnav) {
            if (gnav === golfNavLabel) golfNavRepeats += 1;
            else { golfNavLabel = gnav; golfNavRepeats = 0; }
            if (golfNavRepeats < 1) {
              golfNavClicks += 1;
              return `golf-nav "${gnav}"`;
            }
          }
        }
        // Off a marketing page → click the Book CTA (on the OUTER page — it's
        // what opens the booking widget/iframe). Once we're ALREADY inside the
        // booking iframe, re-clicking it just re-opens the widget and wedges the
        // flow (Gleneagles looped on "BOOK YOUR STAY"), so only fire it before
        // we've entered the engine. GENERAL: the entry CTA is a one-time door.
        if (bf === pageCtx) {
          const cta = await clickBookingEntryDeterministically(pageCtx, {
            golf: !!opts.selectTeeSlot,
          });
          if (cta) {
            if (cta === bookCtaLabel) bookCtaRepeats += 1;
            else { bookCtaLabel = cta; bookCtaRepeats = 0; }
            if (bookCtaRepeats < 2) return `book-cta "${cta}"`;
          }
        }
        // Advance to the next step (Search / Continue / Next) — inside the
        // booking frame. Never commits. Only advance once dates are handled.
        if (datesAlreadySet || !opts.checkinISO) {
          const adv = await clickAdvanceButtonDeterministically(bf);
          if (adv) {
            if (adv === advanceLabel) advanceRepeats += 1;
            else { advanceLabel = adv; advanceRepeats = 0; }
            // Same advance button firing 3+ times in a row = it isn't
            // progressing (no-op / carousel). Stop hammering it: fall through
            // to a stall so the conductor hands off instead of looping 25×.
            if (advanceRepeats >= 3) return null;
            return `advance "${adv}"`;
          }
        }
        return null;
      };
      // AGENT-FIRST. The conductor is NOT the primary driver anymore — it does
      // the quick, obvious clicks (consent, Book CTA, dates, an obvious room/
      // slot, autofill) and then HANDS OFF to the LLM agent the moment it stops
      // making real progress. The agent is reliable on any form and moves step
      // by step (visible progress), whereas a stalled conductor just sits on a
      // frozen screen — the single worst thing in the product. So the patience
      // here is deliberately SHORT: a few stalls or a couple of slow-render
      // waits and we go to the agent, rather than flailing for ~99s first. The
      // loop is bounded four ways: the wall-clock abort (controller.signal),
      // the anti-hammer guards (repeated no-op clicks → stall), STALL_LIMIT,
      // and a hard per-phase wall-clock (CONDUCTOR_BUDGET_MS) that fires EVEN IF
      // the conductor is still making small moves, so it can never run long.
      let stalls = 0;
      let settleStreak = 0;
      let settleLogged = false;
      const CONDUCTOR_MAX_TICKS = 40;
      const STALL_LIMIT = 3; // ~4s of no progress → hand to the agent (was 7)
      const MAX_SETTLE_STREAK = 2; // wait ~3s for a slow render, no more (was 5)
      // Hard wall-clock on the WHOLE conductor phase. This bounds only a
      // conductor that's STILL MAKING MOVES — the no-stare guarantee is the
      // SHORT stall/settle budget above (≈7s of no progress → agent), which
      // fires regardless of this number. So a longer budget can NEVER cause a
      // frozen wait; it only lets a conductor that's actively clicking FINISH on
      // the fast deterministic path instead of handing the back half to the
      // ~12s-per-step agent. HOTELS are the conductor's strong suit (date/room/
      // rate/enhancements/guest are all tuned), so give the productive hotel
      // conductor room to complete the whole checkout itself = ~2 min instead of
      // ~3-4. GOLF stays tight: its deterministic coverage is thin, so when it
      // can't finish we want the agent (with the platform hint) sooner.
      const conductorStartMs = Date.now();
      const CONDUCTOR_BUDGET_MS = opts.selectTeeSlot ? 40_000 : 110_000;
      for (let i = 0; i < CONDUCTOR_MAX_TICKS && !controller.signal.aborted; i++) {
        const action = await tick();
        if (conductorReachedCard) break;
        if (!conductorReachedCard && Date.now() - conductorStartMs > CONDUCTOR_BUDGET_MS) {
          console.log(
            `[stagehand] conductor budget reached (${elapsed()}) — handing to agent`,
          );
          break;
        }
        if (action) {
          stalls = 0;
          settleStreak = 0;
          settleLogged = false;
          console.log(`[stagehand] ⚙ conductor → ${action} (${elapsed()})`);
          await opts.onStep?.(progressLabel(i + 1));
        } else if (
          settleStreak < MAX_SETTLE_STREAK &&
          (await pageStillSettling(stagehand.context.activePage() ?? page))
        ) {
          // The next step is still painting (slow SPA) — don't burn stall budget
          // waiting for it; the next tick will see the rendered page and match.
          settleStreak += 1;
          if (!settleLogged) {
            console.log(
              `[stagehand] ⏳ conductor waiting for slow page to render (${elapsed()})`,
            );
            settleLogged = true;
          }
        } else if (++stalls >= STALL_LIMIT) {
          break; // genuinely novel, settled widget — hand to the AI agent
        }
        await new Promise((r) => setTimeout(r, 1400));
      }
      console.log(
        `[stagehand] conductor ${conductorReachedCard ? "reached card step — skipping agent" : "handed off to agent"} (${elapsed()})`,
      );
      // Handing off STUCK (not at the card step) → dump the booking frame's
      // current step so a step we couldn't drive reveals its real DOM.
      if (!conductorReachedCard) {
        try {
          const sctx = await bookingFrame(stagehand.context.activePage() ?? page);
          const sdiag = await diagnoseBookingStep(sctx);
          if (sdiag) console.log(`[stagehand] 🔬 booking-step diag :: ${sdiag}`);
        } catch {
          /* best-effort */
        }
      }
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
    // PLATFORM SPECIALIZATION (golf): detect the tee-sheet engine from the
    // active page + booking-frame URLs and append a tight, researched flow hint
    // (right tab / rate / login behavior) to the agent's system prompt, so it
    // acts decisively instead of exploring. Logged for triage.
    let systemForAgent = system;
    if (opts.selectTeeSlot) {
      try {
        const ap = stagehand.context.activePage() ?? page;
        const bf2 = await bookingFrame(ap);
        const urlOf = (o: unknown) =>
          typeof (o as { url?: () => string })?.url === "function"
            ? (o as { url: () => string }).url()
            : "";
        const platform = detectGolfPlatform(`${urlOf(ap)} ${urlOf(bf2)}`);
        if (platform) {
          console.log(`[stagehand] 🏷 golf platform: ${platform} (${elapsed()})`);
          systemForAgent = `${system}\n\n${golfPlatformAgentHint(platform)}`;
        }
      } catch {
        /* best-effort */
      }
    }
    const agent = stagehand.agent({
      mode: "dom",
      model: STAGEHAND_MODEL,
      executionModel:
        optionalEnv("STAGEHAND_EXECUTION_MODEL") ?? "anthropic/claude-haiku-4-5",
      systemPrompt: systemForAgent,
    });

    const maxSteps = opts.maxSteps ?? MAX_STEPS;
    let stepCount = 0;
    // Stall-watchdog state. lastStepAt is bumped every time the agent finishes a
    // step (and after a watchdog nudge lands); if it goes quiet for too long the
    // agent is hung and the watchdog steps in. stuckDiagged makes the DOM dump
    // one-shot; wdAdvance* anti-hammers a no-op Search/Continue button.
    let lastStepAt = Date.now();
    let nudging = false;
    let wdAdvanceLabel = "";
    let wdAdvanceRepeats = 0;
    let wdNudgeCount = 0;
    // ADAPTIVE STALL THRESHOLD. Step time varies wildly by hotel — a normal
    // engine finishes a step in ~8-13s, but a heavyweight SPA (Aman) legitimately
    // takes 25-35s per step because its DOM is enormous. A fixed 20s threshold
    // would fire the watchdog DURING a normal Aman step and fight the working
    // agent. So track recent step durations and only call it "frozen" when it's
    // been quiet for ~1.6× the slowest of the last few steps — the watchdog
    // auto-tunes to each hotel's pace instead of one number that's wrong for half
    // of them. GENERAL: never fights a slow-but-working agent, always catches a
    // real freeze (Streamsong froze for 280s — trips at any threshold).
    let prevStepAt = Date.now();
    const recentStepMs: number[] = [];
    // Golf one-shot progress for the watchdog (mirrors the conductor's golf
    // flags) so a frozen tee-sheet advances Visitors → Players → Search → slot →
    // rate one step per wake instead of re-clicking the same one.
    let wdVisitorDone = false;
    let wdPlayersDone = false;
    let wdSearchDone = false;
    let wdSlotDone = false;
    let wdRateDone = false;
    let wdGuestDiagged = false; // one-shot guest-form dump when autofill fills nothing
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
    // SOLD OUT for the requested check-in (hotel or golf date): the calendar
    // shows the target date as "Sold out"/unavailable, so the agent can NEVER
    // set it — surface no_availability (→ "find an alternative") instead of
    // spinning "finalizing your reservation" forever (Streamsong was sold out
    // Aug 10 and Pyltrix just spun). Only when our date-setter couldn't confirm
    // the date AND the target cell is genuinely marked sold-out.
    if (opts.checkinISO && !datesConfirmed) {
      const soldOut = await detectRequestedDatesSoldOut(
        await bookingFrame(stagehand.context.activePage() ?? page),
        opts.checkinISO,
      ).catch(() => false);
      if (soldOut) {
        console.log(
          `[stagehand] 🚫 requested check-in (${opts.checkinISO}) is SOLD OUT — reporting no_availability (${elapsed()})`,
        );
        return {
          outcome: {
            status: "failed",
            failureReason: "no_availability",
            message: opts.selectTeeSlot
              ? "This course is sold out for your date — our concierge can grab a nearby course or a different day."
              : "This property is sold out for your dates — our concierge can find you a comparable place for the trip, or you can pick different dates.",
          },
          sessionUrl,
          finalScreenshot: null,
        };
      }
    }
    // PRIVATE-CLUB FALLBACK (golf): the conductor drilled into the golf section
    // and found no bookable path. Before spending minutes on the agent, check
    // for a clearly PRIVATE / members-only club with NO public booking — if so,
    // bail NOW with a customer-facing message instead of sitting there (a real
    // run sat 2.5 min on a members showcase). Conservative: only fires on a
    // strong private signal AND zero golf-booking widgets, so a bookable course
    // is never wrongly bailed.
    if (opts.selectTeeSlot) {
      // RESORT-GUEST GATE: course requires an existing hotel confirmation
      // number (Sea Island) → can't book standalone, route to concierge to do
      // it WITH the stay (and never sit mis-filling the confirmation field).
      const gateMsg = await detectResortConfirmationGate(
        await bookingFrame(stagehand.context.activePage() ?? page),
      ).catch(() => null);
      if (gateMsg) {
        const stay = opts.resortStay;
        if (stay?.confirmationCode) {
          // The customer IS staying here AND the stay is confirmed — let the
          // agent book the golf as a resort guest using the confirmation number
          // (the goal prompt carries it). Don't bail; fall through to the agent.
          console.log(
            `[stagehand] 🏨 resort-guest golf gate — staying at ${stay.name} (conf ${stay.confirmationCode}); booking as a guest (${elapsed()})`,
          );
        } else if (stay) {
          // Staying here, but the stay isn't confirmed yet (agent-booked hotel,
          // pending) — link the golf to the stay for the concierge to finish
          // together. THIS is the legit "arranging with your stay" case.
          console.log(
            `[stagehand] 🏨 resort-guest golf gate — staying at ${stay.name}, stay not yet confirmed; linking to the stay (${elapsed()})`,
          );
          return {
            outcome: {
              status: "needs_review",
              failureReason: "members_only",
              message: `${stay.name} reserves tee times for resort guests — and you're staying there. Pyltrix is booking your tee time together with your ${stay.name} stay so it's confirmed under your reservation. Nothing for you to do — you'll get it by email.`,
            },
            sessionUrl,
            finalScreenshot: null,
          };
        } else {
          // NOT staying at this resort → the course is private to the customer.
          // FAILED/members_only so the "find a nearby public course" recovery
          // fires and the panel shows the "private — stay to play" message.
          console.log(
            `[stagehand] 🔒 resort-guest golf gate, customer NOT staying here — private to them, routing to a public course (${elapsed()})`,
          );
          return {
            outcome: {
              status: "failed",
              failureReason: "members_only",
              message: gateMsg,
            },
            sessionUrl,
            finalScreenshot: null,
          };
        }
      }
      // NO TEE TIMES for the date → surface "no availability" (don't spin).
      const noAvail = await detectNoTeeAvailability(
        await bookingFrame(stagehand.context.activePage() ?? page),
      ).catch(() => false);
      if (noAvail) {
        console.log(
          `[stagehand] 🚫 golf tee sheet shows NO availability for the date — reporting no_availability (${elapsed()})`,
        );
        return {
          outcome: {
            status: "failed",
            failureReason: "no_availability",
            message:
              "There are no tee times available at this course for the selected date — our concierge can grab a nearby course or a different day.",
          },
          sessionUrl,
          finalScreenshot: null,
        };
      }
      const privMsg = await detectPrivateGolfClub(
        await bookingFrame(stagehand.context.activePage() ?? page),
      ).catch(() => null);
      if (privMsg) {
        console.log(
          `[stagehand] 🔒 private members-only golf — bailing fast, not booking (${elapsed()})`,
        );
        return {
          outcome: {
            // FAILED (not needs_review) so the result page's "Find a nearby
            // course" recovery fires (it keys on failed + members_only).
            status: "failed",
            failureReason: "members_only",
            message: privMsg,
          },
          sessionUrl,
          finalScreenshot: null,
        };
      }
    }
    console.log(
      `[stagehand] agent.execute starting (maxSteps=${maxSteps}, toolTimeout=${TOOL_TIMEOUT_MS}ms)…`,
    );
    // STALL WATCHDOG: the LLM agent sometimes HANGS rather than erroring —
    // Streamsong sat ~280s on the rooms/Book step with ZERO steps logged, just
    // riding the wall-clock to a timeout. The per-step deterministic passes
    // can't rescue that: they're keyed on onStepFinish, which never fires while
    // the agent is hung. So poll on a timer instead. When the agent has gone
    // quiet past STALL_NUDGE_MS we (1) dump the stuck DOM ONCE so the exact step
    // is visible in the next run's logs, and (2) drive the same conductor
    // recognizers (close modal → skip upsell → pick room → autofill → advance)
    // to push the booking forward on our own. Every recognizer self-guards to
    // its step, so a nudge can't act on the wrong screen, and the advance click
    // already refuses to fire on a card step. GENERAL — every hotel/golf form.
    const STALL_CHECK_MS = 8_000;
    const STALL_NUDGE_FLOOR_MS = 22_000; // never call it frozen sooner than this
    const STALL_NUDGE_CEIL_MS = 55_000; // …and never wait longer than this to step in
    // "Frozen" = quiet for longer than ~1.6× the slowest of the last few steps,
    // clamped to [floor, ceil]. On a normal hotel that's ~22s; on a heavyweight
    // SPA whose steps run 30s+ it stretches toward the ceiling so the watchdog
    // doesn't fire mid-step and fight a working agent — but the CEILING matters
    // just as much: without it, one freakishly slow ~97s step (a real Streamsong
    // run) pushed the threshold to ~155s and the watchdog went PASSIVE right when
    // it needed to burst-fill the guest form. Cap it so it always steps in.
    const stallThresholdMs = () =>
      Math.min(
        STALL_NUDGE_CEIL_MS,
        Math.max(
          STALL_NUDGE_FLOOR_MS,
          recentStepMs.length ? Math.max(...recentStepMs) * 1.6 : 0,
        ),
      );
    const WD_NUDGE_CAP = 28; // bounded; a burst uses several, so allow a few bursts
    let wdLastStuckUrl = ""; // re-diag when the frozen screen CHANGES, not just once
    // One deterministic "advance the stuck booking" action — the conductor's
    // recognizers, in order. Returns a label when it acted, else null. Each one
    // self-guards to its own step (room only on a rooms list, advance refuses on
    // a card step, autofill is idempotent), so it can't act on the wrong screen.
    const driveStuckBooking = async (
      active: unknown,
      bf: unknown,
    ): Promise<string | null> => {
      // Blocking modal (page + booking frame).
      {
        const m = await dismissBlockingModalDeterministically(active).catch(() => null);
        if (m) return `closed modal "${m}"`;
      }
      if (bf !== active) {
        const m = await dismissBlockingModalDeterministically(bf).catch(() => null);
        if (m) return `closed modal "${m}"`;
      }
      // GOLF tee-sheet steps — Visitors → Players → Search → slot → rate.
      if (opts.selectTeeSlot) {
        if (!wdVisitorDone) {
          const tab = await clickGuestTabDeterministically(bf).catch(() => null);
          if (tab === "already-visitors") wdVisitorDone = true;
          else if (tab) {
            wdVisitorDone = true;
            return `guest-tab "${tab}"`;
          }
        }
        if (!wdPlayersDone) {
          const p = await setPlayersCountDeterministically(bf, opts.players ?? null).catch(
            () => null,
          );
          if (p) {
            if (p !== "players-open") wdPlayersDone = true;
            return `players ${p}`;
          }
        }
        if (!wdSearchDone) {
          const s = await clickGolfSearchDeterministically(bf).catch(() => null);
          if (s) {
            wdSearchDone = true;
            return `golf-search "${s}"`;
          }
        }
        if (!wdSlotDone) {
          const slot = await clickTeeTimeSlotDeterministically(
            bf,
            opts.teeTimeLabel ?? null,
          ).catch(() => null);
          if (slot) {
            wdSlotDone = true;
            return `slot ${slot}`;
          }
        }
        if (!wdRateDone) {
          const rate = await selectCheapestRateRadioDeterministically(bf).catch(() => null);
          if (rate) {
            wdRateDone = true;
            return `rate ${rate}`;
          }
        }
      }
      // Upsell / add-on step.
      {
        const up = await clickThroughUpsellDeterministically(bf).catch(() => null);
        if (up) return `upsell-skip "${up}"`;
      }
      // Hotel room — lodging only, one-shot (rooms stay visible on two-panel
      // engines, so without roomPicked this would re-click forever).
      if (!opts.selectTeeSlot && !roomPicked) {
        const r = await clickCheapestRoomDeterministically(bf).catch(() => null);
        if (r) {
          roomPicked = true;
          return `room ${r}`;
        }
      }
      // Reveal a collapsed guest form (Agilysys "Add Guest"), one-shot.
      if (opts.autofill && !guestFormRevealed) {
        const ag = await clickAddGuestDeterministically(bf).catch(() => null);
        if (ag) {
          guestFormRevealed = true;
          return `reveal-guest "${ag}"`;
        }
      }
      // Autofill BEFORE advancing, so a half-empty form isn't submitted blank.
      if (opts.autofill) {
        const n = await deterministicGuestFill(bf, opts.autofill).catch(() => 0);
        if (n > 0) return `autofill ${n} fields`;
        // Filled nothing — but a guest form may well be on screen (a field-
        // matching miss). Dump its real structure ONCE so the gap is fixable
        // from DOM, not a guess.
        if (!wdGuestDiagged) {
          wdGuestDiagged = true;
          const gd = await diagnoseGuestForm(bf).catch(() => "");
          if (gd) console.log(`[stagehand] 🔬 STUCK guest-form diag :: ${gd}`);
        }
      }
      // Advance (Continue / Proceed / Save). Refuses on a card step; anti-hammer
      // stops a no-op button after a few identical clicks. Once the room is
      // picked, exclude the room-"Search" button — on a two-panel engine it
      // stays visible and only RE-runs the search, never moves forward.
      {
        const a = await clickAdvanceButtonDeterministically(bf, {
          excludeSearch: roomPicked,
        }).catch(() => null);
        if (a) {
          if (a === wdAdvanceLabel) wdAdvanceRepeats += 1;
          else {
            wdAdvanceLabel = a;
            wdAdvanceRepeats = 0;
          }
          if (wdAdvanceRepeats < 4) return `advance "${a}"`;
        }
      }
      return null;
    };
    stallWatch = setInterval(() => {
      void (async () => {
        if (controller.signal.aborted || nudging) return;
        if (Date.now() - lastStepAt < stallThresholdMs()) return; // agent still working at this hotel's pace
        if (wdNudgeCount >= WD_NUDGE_CAP) return;
        nudging = true;
        try {
          // The agent is FROZEN. First capture WHERE — and re-capture whenever the
          // frozen screen changes (the first stall consumed the old one-shot diag,
          // so a later, different freeze like Proceed was invisible). Then
          // BURST-DRIVE: run the deterministic recognizers back-to-back so a
          // multi-step finish (Add Guest → autofill → Proceed) completes in a few
          // seconds, not one action per 20s wake.
          {
            const a0 = stagehand.context.activePage();
            const bf0 = a0 ? await bookingFrame(a0).catch(() => a0) : null;
            let url0 = "";
            try {
              url0 = (a0 as { url?: () => string })?.url?.() ?? "";
            } catch {
              /* best-effort */
            }
            if (bf0 && url0 !== wdLastStuckUrl) {
              wdLastStuckUrl = url0;
              stuckDiagged = true; // so the catch/post-run fallback diag doesn't double-dump
              const idle = ((Date.now() - lastStepAt) / 1000).toFixed(0);
              const d = await diagnoseBookingStep(bf0).catch(() => "");
              if (d)
                console.log(
                  `[stagehand] 🔬 STUCK booking-step diag (agent idle ${idle}s, step ${stepCount}) :: ${d}`,
                );
            }
          }
          const BURST_MAX = 8;
          for (
            let b = 0;
            b < BURST_MAX && !controller.signal.aborted && wdNudgeCount < WD_NUDGE_CAP;
            b++
          ) {
            const active = stagehand.context.activePage();
            if (!active) break;
            const bf = await bookingFrame(active).catch(() => active);
            if (await detectCardFieldPresent(bf).catch(() => false)) break; // at the card step
            const did = await driveStuckBooking(active, bf);
            if (!did) break; // nothing left to do deterministically — let the agent/clock take over
            wdNudgeCount += 1;
            console.log(
              `[stagehand] 🫀 stall-watchdog (frozen agent) → ${did} (${elapsed()})`,
            );
            await new Promise((r) => setTimeout(r, 1100)); // let each action land
          }
          lastStepAt = Date.now(); // re-arm: give the burst time before firing again
        } catch {
          /* best-effort */
        } finally {
          nudging = false;
        }
      })();
    }, STALL_CHECK_MS);
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
          const now = Date.now();
          // Record how long this step took so the watchdog can adapt its
          // "frozen" threshold to THIS hotel's pace (keep the last 5).
          recentStepMs.push(now - prevStepAt);
          if (recentStepMs.length > 5) recentStepMs.shift();
          prevStepAt = now;
          lastStepAt = now; // agent is alive — reset the stall watchdog
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
              // Close any blocking info/promo modal mid-run (the agent used to
              // sit ~2 min on Sea Island's "Rate Availability" popup) — on the
              // page AND inside the booking iframe. Guarded so it never closes a
              // real booking step. GENERAL — every site.
              const modal = await dismissBlockingModalDeterministically(active);
              if (modal)
                console.log(
                  `[stagehand] ⚡ closed blocking modal ("${modal}") (${elapsed()})`,
                );
              const af = await bookingFrame(active).catch(() => active);
              if (af && af !== active) {
                const fmodal = await dismissBlockingModalDeterministically(af);
                if (fmodal)
                  console.log(
                    `[stagehand] ⚡ closed blocking modal in iframe ("${fmodal}") (${elapsed()})`,
                  );
              }
              // Keep everything in one tab (the override resets on navigation).
              if (active) await forceSingleTab(active);
            }
          } catch {
            /* best-effort */
          }
          // INSTANT GUEST AUTOFILL: zero-LLM pass after every step. When a
          // guest/checkout form appears, every recognised empty field (names,
          // email, phone, address, title) is filled in ~100ms — the agent then
          // verifies and clicks Continue instead of typing field-by-field at
          // ~10s a step (a Belmond run burned minutes transcribing data we
          // already had).
          if (opts.autofill) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                // Run the guest recognizers against the BOOKING FRAME, not just
                // the outer page. Many hotel engines (Agilysys — Streamsong's
                // spend.onagilysys.com — plus SynXis / iHotelier) load the whole
                // checkout, INCLUDING the guest form, inside an iframe; filling
                // the outer page found nothing and left the form empty
                // (Streamsong sat ~7 min on an empty contact form). bookingFrame
                // resolves the child frame holding booking content and falls
                // back to the page for non-iframe SPAs, so it's safe everywhere.
                const target =
                  (await bookingFrame(active).catch(() => active)) ?? active;
                // Re-diagnose when the booking moves to a NEW host — the first
                // diag often captures the marketing site's inquiry form; we want
                // the real checkout engine's DOM (e.g. onagilysys.com).
                let host = "";
                try {
                  host = new URL(
                    (target as { url?: () => string }).url?.() ?? "",
                  ).host;
                } catch {
                  /* frame URL unavailable */
                }
                if (!guestFormDiagnosed || (host && host !== lastGuestDiagHost)) {
                  const gdiag = await diagnoseGuestForm(target).catch(() => "");
                  if (gdiag) {
                    guestFormDiagnosed = true;
                    if (host) lastGuestDiagHost = host;
                    console.log(`[stagehand] 🔬 guest-form diag :: ${gdiag}`);
                  }
                }
                // Reveal a collapsed guest form first (Agilysys "Add Guest")
                // so the First/Last/Email fields exist before we autofill.
                if (!guestFormRevealed) {
                  const revealed = await clickAddGuestDeterministically(target).catch(
                    () => null,
                  );
                  if (revealed) {
                    guestFormRevealed = true;
                    console.log(
                      `[stagehand] ⚡ revealed guest form ("${revealed}") (${elapsed()})`,
                    );
                  }
                }
                const filled = await deterministicGuestFill(target, opts.autofill);
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
          // setter the moment the widget shows, instead of the agent grinding it.
          if (opts.checkinISO && !datesAlreadySet) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                // Drive against the booking FRAME — engines like Boyne ("brwf"
                // widget on Inn at Bay Harbor) load the date picker in an iframe.
                const dctx =
                  (await bookingFrame(active).catch(() => active)) ?? active;
                let r = await clickStayDatesDeterministically(
                  dctx,
                  opts.checkinISO ?? null,
                  opts.checkoutISO ?? null,
                );
                // Arrival landed but check-OUT is still pending — range pickers
                // only enable departure AFTER arrival is chosen. Run dedicated
                // checkout-only passes to FINISH the range. (The old code marked
                // dates "done" on the first `in=…` even when it was
                // `out=PENDING`, so the departure never got set — Bay Harbor sat
                // on a half-set "Jul 10" range forever.)
                if (opts.checkoutISO && r != null && r.includes("out=PENDING")) {
                  for (let i = 0; i < 3; i++) {
                    await new Promise((res) => setTimeout(res, 700));
                    const od =
                      (await bookingFrame(active).catch(() => active)) ?? active;
                    const outRes = await clickStayDatesDeterministically(
                      od,
                      null,
                      opts.checkoutISO ?? null,
                    );
                    if (outRes && outRes.startsWith("out=")) {
                      r = `in=${opts.checkinISO} out=${opts.checkoutISO}`;
                      break;
                    }
                  }
                }
                // Check-out STILL won't resolve → dump the calendar DOM once so
                // the cell selector can be built from the real markup next run.
                if (
                  opts.checkoutISO &&
                  r != null &&
                  r.includes("out=PENDING") &&
                  !calendarDiagnosed
                ) {
                  calendarDiagnosed = true;
                  const cdiag = await diagnoseCalendar(dctx).catch(
                    () => "(diag failed)",
                  );
                  console.log(
                    `[stagehand] 🔬 calendar diag (out=PENDING) :: ${cdiag}`,
                  );
                }
                // Mark DONE only when the range is COMPLETE — never on
                // out=PENDING, so the next step keeps chasing the departure.
                const complete =
                  r != null &&
                  r !== "OPENED" &&
                  r !== "ADVANCING" &&
                  r.startsWith("in=") &&
                  !(opts.checkoutISO && r.includes("out=PENDING"));
                if (complete) {
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
          // GOLF CART → CHECKOUT (per step): after the slot is in the cart, golf
          // sites need an "Add to cart" / "Checkout" / "Proceed" click to reach
          // the guest form — a real Grande Dunes run ground 36 AI steps on this.
          // Drive it deterministically. clickAdvanceButtonDeterministically
          // NEVER clicks a commit verb (Book/Pay/Confirm) and bails at the card
          // step, so it can't submit the booking — only move toward checkout.
          if (opts.selectTeeSlot && slotAlreadyPicked && !golfAdvanceStuck) {
            try {
              const active = stagehand.context.activePage();
              if (active) {
                const adv = await clickAdvanceButtonDeterministically(active);
                if (adv) {
                  if (adv === golfAdvanceLabel) golfAdvanceCount += 1;
                  else { golfAdvanceLabel = adv; golfAdvanceCount = 1; }
                  console.log(
                    `[stagehand] ⚡ golf checkout advance ("${adv}") (${elapsed()})`,
                  );
                  // Same button 3× in a row isn't advancing (GolfNow "Search"
                  // re-runs the search) — stop the per-step advance so it can't
                  // loop ~15 times; let the agent take it from here.
                  if (golfAdvanceCount >= 3) {
                    golfAdvanceStuck = true;
                    console.log(
                      `[stagehand] ⚙ golf checkout advance stuck on "${adv}" — stopping per-step advance (${elapsed()})`,
                    );
                  }
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
    if (stallWatch) {
      clearInterval(stallWatch);
      stallWatch = null;
    }
    }
    console.log(
      `[stagehand] ✓ agent finished (${elapsed()}) success=${result.success} completed=${result.completed} steps=${result.actions?.length ?? stepCount}\n  agent message: ${result.message?.slice(0, 600) || "(no message)"}`,
    );
    // If the agent stopped WITHOUT confirming (success=false, or a thin/empty
    // message that signals a silent stop), dump where it ended — the conductor's
    // handoff diag only captures the START of the agent phase, not where the
    // agent itself gave up. One line, best-effort, so the next run is fixable
    // from real DOM instead of a guess.
    if (
      !stuckDiagged &&
      (result.success === false || (result.message ?? "").trim().length < 40)
    ) {
      try {
        const sctx = await bookingFrame(stagehand.context.activePage() ?? page);
        const sdiag = await diagnoseBookingStep(sctx);
        if (sdiag)
          console.log(`[stagehand] 🔬 agent-stopped booking-step diag :: ${sdiag}`);
      } catch {
        /* best-effort */
      }
    }
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
        // MVP REVIEW-BEFORE-CHARGE GATE: pause at the FILLED card step for a
        // mandatory one-tap customer approval before ANY money moves — no card
        // is minted here, the customer is never charged. Reuses the
        // price_approval contract so the existing "Approve & book" button +
        // approve-price route complete it: on approval the booking re-runs with
        // the gate lifted and pays. The caller turns this OFF once approved and
        // for pay-at-course golf, so it never double-pauses or slows golf down.
        if (opts.requirePaymentReview) {
          console.log(
            `[stagehand] review-before-charge — pausing at card step for customer approval (${elapsed()})`,
          );
          return {
            outcome: {
              status: "needs_review",
              failureReason: "price_approval",
              priceCents: pay.amountCents ?? undefined,
              message:
                pay.amountCents != null
                  ? `Everything's filled in and ready to book — total $${Math.round(
                      pay.amountCents / 100,
                    ).toLocaleString()}${pay.currency ? ` ${pay.currency}` : ""}. Review and approve to confirm — Pyltrix books it immediately.`
                  : "Everything's filled in and ready to book at the payment step. Review and approve to confirm — Pyltrix books it immediately.",
            },
            sessionUrl,
            finalScreenshot: null,
          };
        }
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
    // On a wall-clock TIMEOUT, dump where it died (unless the watchdog already
    // captured a stuck step) so a slow/looping site is fixable from real DOM.
    if (aborted && !heavyAbort && !stuckDiagged) {
      try {
        const ap =
          stagehand.context.activePage() ?? stagehand.context.pages().at(-1);
        const sctx = await bookingFrame(ap);
        const sdiag = await diagnoseBookingStep(sctx);
        if (sdiag)
          console.log(`[stagehand] 🔬 timed-out booking-step diag :: ${sdiag}`);
      } catch {
        /* best-effort */
      }
    }
    // A wall-clock TIMEOUT (the 4-min lock-in) isn't a failure — the agent was
    // actively booking when the clock hit. Hand it to the CONCIERGE
    // (needs_review), not a red "couldn't book", so the customer waits ≤4 min
    // and a human finishes whatever's left. Heavy-page + real crashes still
    // fail (link/phone fallback / retry).
    if (aborted && !heavyAbort) {
      return {
        outcome: {
          status: "needs_review",
          failureReason: "timeout",
          message:
            "Pyltrix is finalizing this booking — this venue's site is an unusually slow one, so our concierge is completing it. You'll get the confirmation by email.",
        },
        sessionUrl: null,
        finalScreenshot: null,
      };
    }
    return {
      outcome: {
        status: "failed",
        failureReason: heavyAbort ? "form_not_found" : "ambiguous",
        message: heavyAbort
          ? "This venue's website is too heavy for automated booking — finish directly via the link or phone below."
          : msg,
      },
      sessionUrl: null,
      finalScreenshot: null,
    };
  } finally {
    clearTimeout(wallClock);
    if (stallWatch) clearInterval(stallWatch);
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

        // ── Strategy 0: PIKADAY (one of the most common hotel pickers — The
        // Pearl and countless others). CRUCIAL: Pikaday changes month / selects
        // a day on a real MOUSEDOWN of .pika-next / .pika-prev / .pika-button —
        // a plain .click() fires only a 'click' event, which Pikaday ignores.
        // That's why the generic setter "advanced" forever while the calendar
        // never moved off the current month (no-op arrow clicks → ping-pong
        // OPENED/ADVANCING → 2-minute agent fallback). Drive it with proper
        // mouse events. Pikaday redraws SYNCHRONOUSLY on mousedown, so the whole
        // walk-to-month + pick-day completes in this one pass, in milliseconds.
        if (document.querySelector("[data-pika-day]")) {
          const fire = (el: Element) => {
            for (const type of ["mousedown", "mouseup", "click"]) {
              el.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, view: window }),
              );
            }
          };
          const dayCells = () =>
            Array.from(
              document.querySelectorAll<HTMLElement>("button.pika-button[data-pika-day]"),
            ).filter(isVisible);
          // The month currently DRAWN, as year*12 + 0-indexed-month, taken as the
          // dominant month among visible cells (a single-month grid shows one
          // month plus a few faded adjacent days).
          const drawnKey = (): number | null => {
            const counts: Record<number, number> = {};
            for (const c of dayCells()) {
              const y = parseInt(c.getAttribute("data-pika-year") || "", 10);
              const m = parseInt(c.getAttribute("data-pika-month") || "", 10);
              if (Number.isFinite(y) && Number.isFinite(m)) {
                const k = y * 12 + m;
                counts[k] = (counts[k] || 0) + 1;
              }
            }
            let best: number | null = null;
            let bestN = 0;
            for (const k in counts) {
              if (counts[k] > bestN) { bestN = counts[k]; best = parseInt(k, 10); }
            }
            return best;
          };
          // Walk to the target month then mousedown the exact day. Returns
          // "picked" | "no-day" (month reached, day disabled/missing) |
          // "async" (a nav click didn't redraw this pass → let the outer poll
          // retry) | null (can't act).
          const walk = (iso: string): "picked" | "no-day" | "async" | null => {
            const [ty, tm, td] = iso.split("-").map((n) => parseInt(n, 10));
            const wantKey = ty * 12 + (tm - 1);
            for (let i = 0; i < 18; i++) {
              const cur = drawnKey();
              if (cur == null) return null;
              if (cur === wantKey) {
                const cell = dayCells().find(
                  (c) =>
                    parseInt(c.getAttribute("data-pika-year") || "", 10) === ty &&
                    parseInt(c.getAttribute("data-pika-month") || "", 10) === tm - 1 &&
                    parseInt(c.getAttribute("data-pika-day") || "", 10) === td &&
                    !/is-disabled/.test(c.parentElement?.className || ""),
                );
                if (!cell) return "no-day";
                fire(cell);
                return "picked";
              }
              const nav = document.querySelector<HTMLElement>(
                wantKey > cur ? ".pika-next" : ".pika-prev",
              );
              if (!nav || !isVisible(nav)) return null;
              fire(nav);
              // Pikaday redraws synchronously; if the month didn't move, it's an
              // async fork — bail and let the outer poll re-enter post-redraw.
              if (drawnKey() === cur) return "async";
            }
            return null;
          };
          if (ci == null && co != null) {
            const r = walk(co);
            if (r === "picked") return `out=${co}`;
            if (r === "async") return "ADVANCING";
            return null;
          }
          if (ci != null) {
            const r1 = walk(ci);
            if (r1 === "async") return "ADVANCING";
            if (r1 === "picked") {
              if (co == null) return `in=${ci}`;
              const r2 = walk(co);
              return `in=${ci}${r2 === "picked" ? ` out=${co}` : " out=PENDING"}`;
            }
            return null;
          }
        }

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
          // An Angular MATERIAL datepicker toggle is the most reliable opener —
          // its "Choose date" input is readonly, so only the toggle (or clicking
          // the input) opens the <mat-calendar>. Common on golf tee sheets
          // (Total-e-Integrated) and Material SPAs. Try it first.
          const toggle = Array.from(
            document.querySelectorAll<HTMLElement>(
              "mat-datepicker-toggle button, .mat-datepicker-toggle button, [class*=datepicker-toggle i] button, button[aria-label*=calendar i], button[aria-label='Choose date'], button[aria-label*='select date' i]",
            ),
          ).find(isVisible);
          if (toggle) {
            toggle.click();
            return true;
          }
          const want = [
            "check-in", "check in", "checkin", "arrival", "arrive",
            "select dates", "select your dates", "choose dates", "dates",
            "add dates",
            // SINGLE-DATE triggers (golf tee sheets, Material "Choose date") —
            // the old list was hotel-only ("choose dates" plural), so a tee-time
            // "Choose date" field never opened and the page stayed on today.
            "choose date", "select date", "pick a date", "pick date",
            "tee date", "play date", "event date", "reservation date",
            "booking date", "round date",
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

        // ── Strategy 0: ARIA date grid + MONTH NAVIGATION ────────────────
        // The luxury-hotel pattern (One&Only/SynXis/react-aria): each day is a
        //   <td role="gridcell" aria-label="11" aria-disabled="false">11<div>USD 1,148</div></td>
        // inside a month grid labelled "August 2026". TWO things broke the old
        // matcher: (1) the day's identity is the aria-label "11" (price is
        // "USD 1,148" — no $/€ symbol, so the text+price matcher missed it),
        // and (2) the calendar opens on the CURRENT month, so the target month
        // must be reached by clicking the next-month arrow first. Handles both.
        const ABBR_M: Record<string, string> = {
          jan: "January", feb: "February", mar: "March", apr: "April",
          jun: "June", jul: "July", aug: "August", sep: "September",
          sept: "September", oct: "October", nov: "November", dec: "December",
        };
        const monthKeyFrom = (raw: string): string | null => {
          const t = (raw || "")
            .replace(/[‹›<>«»→←]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          const yr = t.match(/\b(20\d{2})\b/)?.[1];
          let mon = MONTHS.find((mn) => t.includes(mn.toLowerCase()));
          if (!mon) {
            for (const k of Object.keys(ABBR_M)) {
              if (new RegExp(`\\b${k}`).test(t)) { mon = ABBR_M[k]; break; }
            }
          }
          return mon && yr ? `${mon.toLowerCase()} ${yr}` : null;
        };
        // Day cells: [role=gridcell] (One&Only / SynXis) AND plain day-number
        // buttons/cells. ChronoGolf/Lightspeed renders "11" as a <button> with
        // no role=gridcell — a real run advanced months FOREVER because these
        // weren't in the grid. Keep any role=gridcell; otherwise require the
        // element's OWN text to be just a 1-2 digit day.
        const gridCells = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[role=gridcell], button, a, [role=button], td, li, div",
          ),
        ).filter((el) => {
          if (!isVisible(el)) return false;
          if (el.matches?.("[role=gridcell]")) return true;
          const raw = (el.textContent || "").trim();
          // Pure day number ("12").
          if (/^\d{1,2}$/.test(raw.replace(/\s+/g, ""))) return true;
          // Day number FOLLOWED BY a rate/status — Streamsong-style cells are
          // "21 $307" / "20 Sold out" / "12 $1,058". Match a short cell that
          // STARTS with a 1-2 digit day and carries a price or sold-out marker,
          // so a priced calendar grid is no longer skipped. (cellISO already
          // pulls the leading day number; the month comes from the header.)
          return (
            raw.length <= 22 &&
            /^\d{1,2}\b/.test(raw) &&
            /\$\s?\d|sold\s*out|unavailable|\/\s*night/i.test(raw)
          );
        });
        // The month a cell sits under, from an ancestor aria-label/caption
        // (One&Only's <table aria-label="August 2026">) OR the nearest preceding
        // month HEADER element in document order (The Breakers' <h2>June 2026</h2>).
        const monthOfCell = (cell: HTMLElement): string | null => {
          let n: HTMLElement | null = cell;
          for (let i = 0; i < 9 && n; i++) {
            const al = n.getAttribute?.("aria-label");
            if (al) { const k = monthKeyFrom(al); if (k) return k; }
            if (n.tagName === "TABLE") {
              const cap = n.querySelector("caption");
              if (cap) { const k = monthKeyFrom(cap.textContent || ""); if (k) return k; }
            }
            n = n.parentElement;
          }
          const heads = Array.from(
            document.querySelectorAll<HTMLElement>(
              "h1,h2,h3,h4,caption,[class*=month i],[class*=cal-header i],[class*=header i]",
            ),
          );
          let best: string | null = null;
          for (const h of heads) {
            const k = monthKeyFrom((h.textContent || "").slice(0, 30));
            if (k && h.compareDocumentPosition(cell) & 4) best = k; // h precedes cell
          }
          // SINGLE-MONTH widgets (ChronoGolf) show the month as a bare label
          // ("August 2026") that isn't an h-tag, so the preceding-header scan
          // misses it. If EXACTLY ONE such label is visible, every day cell
          // belongs to it. Guarded to one label so a dual-month calendar (Aman/
          // SynXis) is never mis-assigned.
          if (!best) {
            const labels = Array.from(
              new Set(
                Array.from(
                  document.querySelectorAll<HTMLElement>(
                    "button,span,div,h1,h2,h3,h4,[class*=title i],[class*=month i]",
                  ),
                )
                  .filter(isVisible)
                  .map((el) => (el.textContent || "").trim())
                  .filter((t) => /^[a-zà-ÿ]{3,}\s+20\d{2}$/i.test(t)),
              ),
            );
            if (labels.length === 1) {
              const k = monthKeyFrom(labels[0]);
              if (k) best = k;
            }
          }
          return best;
        };
        // Resolve a cell's FULL date → ISO, from the strongest signal available:
        //  1) a date="M/D/YY" / data-date attr (cell or descendant — The Breakers'
        //     mwl-calendar puts date="6/28/26" on the inner link),
        //  2) an aria-label containing "Month D, YYYY",
        //  3) the day number + the cell's month (monthOfCell).
        const cellISO = (cell: HTMLElement): string | null => {
          // Pikaday — one of the most common date pickers on hotel sites (The
          // Pearl, and countless others). The day button carries the FULL date
          // in data-pika-year / data-pika-month / data-pika-day. CRUCIAL: the
          // month is 0-INDEXED (data-pika-month="5" is June), so +1. Without
          // this the resolver couldn't read a single cell and the setter looped
          // "OPENED" forever, dumping every Pikaday hotel to the slow agent.
          const pk =
            (cell.matches?.("[data-pika-day]") ? cell : null) ??
            cell.querySelector<HTMLElement>("[data-pika-day]");
          if (pk) {
            const py = pk.getAttribute("data-pika-year");
            const pm = pk.getAttribute("data-pika-month");
            const pd = pk.getAttribute("data-pika-day");
            if (py && pm != null && pd != null) {
              const mi = parseInt(pm, 10) + 1;
              if (mi >= 1 && mi <= 12)
                return `${py}-${String(mi).padStart(2, "0")}-${String(parseInt(pd, 10)).padStart(2, "0")}`;
            }
          }
          const dEl =
            (cell.matches?.("[date],[data-date]") ? cell : null) ??
            cell.querySelector<HTMLElement>("[date],[data-date]");
          const dAttr =
            dEl?.getAttribute("date") || dEl?.getAttribute("data-date") || "";
          let m = dAttr.match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (m) return `${m[1]}-${m[2]}-${m[3]}`;
          m = dAttr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
          if (m) {
            let y = parseInt(m[3], 10); if (y < 100) y += 2000;
            return `${y}-${String(+m[1]).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
          }
          const al = (
            cell.getAttribute("aria-label") ||
            cell.querySelector("[aria-label]")?.getAttribute("aria-label") ||
            ""
          ).toLowerCase();
          const lbl = al.match(/\b([a-zà-ÿ]{3,})\s+(\d{1,2}),?\s+(20\d{2})/);
          if (lbl) {
            const mi = MONTHS.findIndex((mn) =>
              mn.toLowerCase().startsWith(lbl[1].slice(0, 3)),
            );
            if (mi >= 0)
              return `${lbl[3]}-${String(mi + 1).padStart(2, "0")}-${String(+lbl[2]).padStart(2, "0")}`;
          }
          const dayStr =
            al.match(/^(\d{1,2})\b/)?.[1] ||
            (cell.textContent || "").trim().match(/^(\d{1,2})\b/)?.[1];
          const hk = monthOfCell(cell);
          if (dayStr && hk) {
            const [mon, yr] = hk.split(" ");
            const mi = MONTHS.findIndex((mn) => mn.toLowerCase() === mon);
            if (mi >= 0)
              return `${yr}-${String(mi + 1).padStart(2, "0")}-${String(+dayStr).padStart(2, "0")}`;
          }
          return null;
        };
        const clickableInCell = (cell: HTMLElement): HTMLElement => {
          const inner = cell.querySelector<HTMLElement>(
            "[role=link],[role=button],a,button,[tabindex]",
          );
          return inner && isVisible(inner) ? inner : cell;
        };
        const clickNextMonth = (): boolean => {
          const cands = Array.from(
            document.querySelectorAll<HTMLElement>(
              "button,[role=button],a,[class*=next i],[class*=forward i],[aria-label*=next i],[title*=next i],[class*=arrow i]",
            ),
          ).filter(isVisible);
          for (const el of cands) {
            const lab = (
              (el.getAttribute("aria-label") || "") + " " +
              (el.getAttribute("title") || "") + " " +
              (el.className || "")
            ).toLowerCase();
            if (/\byear\b|prev|previous|\bback\b/.test(lab)) continue;
            if (/next|forward/.test(lab)) { el.click(); return true; }
          }
          for (const el of cands) {
            const t = (el.textContent || "").trim();
            if (/^[›»→>❯➔]$/.test(t)) { el.click(); return true; }
          }
          return false;
        };
        // Returns "clicked" (day selected), "ADVANCING" (moved a month toward
        // the target), or null (not an aria grid / can't act this pass).
        const handleAriaGrid = (iso: string): "clicked" | "ADVANCING" | null => {
          if (gridCells.length < 8) return null;
          const resolved = gridCells
            .map((c) => ({ c, iso: cellISO(c) }))
            .filter((x): x is { c: HTMLElement; iso: string } => x.iso != null);
          if (resolved.length === 0) return null; // not a resolvable date grid
          const unavailable = (c: HTMLElement): boolean => {
            if (
              c.getAttribute("aria-disabled") === "true" ||
              (c as HTMLButtonElement).disabled
            )
              return true;
            const sig =
              (c.getAttribute("aria-label") || "") + " " + (c.className || "");
            if (
              /unavailable|sold|not\s*available|fully\s*committed|disabled|cal-past|outside|other-?month|adjacent|prev-?month|next-?month|muted|faded|is-?empty/i.test(
                sig,
              )
            )
              return true;
            // Out-of-month TRAILING days (the greyed 28/29/30 of the prev month
            // and 01-08 of the next, shown to pad the grid) carry the SAME bare
            // number as a real in-month day. On a single-month widget every cell
            // is labelled with that one visible month, so those trailing numbers
            // collide with the target (a "Jul 1" target also matched the greyed
            // "Aug 1"). They're visually de-emphasised — treat a clearly faded
            // cell as unavailable so the booking always lands on the real
            // in-month day. (>0.45 keeps normal cells; trailing days are ~0.3.)
            const st = window.getComputedStyle(c);
            if (Number(st.opacity || "1") < 0.45) return true;
            return false;
          };
          const hit = resolved.find((x) => x.iso === iso && !unavailable(x.c));
          if (hit) {
            clickableInCell(hit.c).click();
            return "clicked";
          }
          // Target month not on screen → advance toward it.
          const targetYM = iso.slice(0, 7);
          const monthsPresent = new Set(resolved.map((x) => x.iso.slice(0, 7)));
          if (!monthsPresent.has(targetYM)) {
            if (clickNextMonth()) return "ADVANCING";
          }
          return null;
        };

        // ── Checkout-only pass (ci omitted) ──────────────────────────────
        if (ci == null) {
          if (co == null) return null;
          if (typeInto(co, "out")) return `out=${co}`;
          const g = handleAriaGrid(co);
          if (g === "ADVANCING") return "ADVANCING";
          if (g === "clicked") return `out=${co}`;
          const outCell = findCell(co);
          if (outCell) {
            outCell.click();
            return `out=${co}`;
          }
          return null;
        }

        // ── Full pass: typing first (most reliable), then ARIA grid, cells ─
        // co == null is the SINGLE-DATE case (golf tee time): set only the one
        // date, no departure. Otherwise it's a stay range (check-in/out).
        if (typeInto(ci, "in")) {
          if (co == null) return `in=${ci}`;
          const typedOut = typeInto(co, "out");
          return `in=${ci}${typedOut ? ` out=${co}` : " out=PENDING"}`;
        }

        // ARIA date grid (with month navigation) — the luxury-hotel path.
        const gIn = handleAriaGrid(ci);
        if (gIn === "ADVANCING") return "ADVANCING";
        if (gIn === "clicked") {
          if (co == null) return `in=${ci}`;
          const gOut = handleAriaGrid(co);
          return `in=${ci}${gOut === "clicked" ? ` out=${co}` : " out=PENDING"}`;
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
/**
 * Dump the guest/checkout form's REAL field structure (one compact JSON line)
 * so a per-engine driver can be built from the actual DOM instead of guessing
 * from screenshots. Fires once per run, only on a real guest form (a name field
 * present). Captures each control's identifying attributes + label, the phone
 * widget's markup, and any custom (non-<select>) dropdowns — exactly what's
 * needed to fix the Title/Country pickers and the dial-code selector.
 */
/**
 * Dump the booking engine's CURRENT step (one compact JSON line): the visible
 * clickable controls, priced "cards" (room/rate tiles), headings, and inputs +
 * the frame URL. Fired when the conductor hands off STUCK, so a step it couldn't
 * drive reveals its real DOM (what the "room" actually is, what the advance
 * button is named) — for fixing the recognizer precisely instead of guessing.
 */
async function diagnoseBookingStep(page: unknown): Promise<string> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return "";
  try {
    return await cdp.evaluate<string>(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects?.();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // Is this element part of the site CHROME (nav / header / footer / cookie
      // bar) rather than the booking content? On big marketing SPAs (Aman) the
      // chrome has dozens of links + footer items that swamp the diag and bury
      // the actual room cards, so the diag came back useless. Skip chrome so the
      // capture is the booking step. GENERAL — every nav-heavy hotel SPA.
      const inChrome = (el: Element): boolean => {
        let n: Element | null = el;
        for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
          const tag = n.tagName;
          if (tag === "NAV" || tag === "HEADER" || tag === "FOOTER") return true;
          if (/navigation|banner|contentinfo/i.test(n.getAttribute("role") || ""))
            return true;
          const cls =
            typeof (n as HTMLElement).className === "string"
              ? (n as HTMLElement).className
              : "";
          if (
            /(^|[-_\s])(navbar|navigation|site-?header|site-?footer|page-?header|page-?footer|main-?nav|top-?nav|mega-?menu|cookie|consent|gdpr|onetrust)([-_\s]|$)/i.test(
              `${cls} ${n.id || ""}`,
            )
          )
            return true;
        }
        return false;
      };
      const clip = (s: string | null | undefined, n: number) =>
        (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const uniq = (a: string[]) => a.filter((t, i) => t && a.indexOf(t) === i);
      const content = (el: Element) => vis(el) && !inChrome(el);
      const buttons = uniq(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            "button,a,[role=button],input[type=submit],input[type=button]",
          ),
        )
          .filter(content)
          .map((el) =>
            clip(
              el.innerText || el.textContent || (el as HTMLInputElement).value || el.getAttribute("aria-label"),
              32,
            ),
          ),
      ).slice(0, 40);
      const priced = uniq(
        Array.from(document.querySelectorAll<HTMLElement>("*"))
          .filter(
            (el) =>
              content(el) &&
              el.tagName !== "SCRIPT" &&
              el.tagName !== "STYLE" &&
              el.children.length <= 4 &&
              // Include ¥/₩/₹ — Aman Tokyo (and other markets) quote in yen, which
              // the old $/£/€-only check missed, so no real price ever showed.
              /[£$€¥₩₹]\s?\d|\d[\d.,]*\s?(?:USD|GBP|EUR|JPY|CNY|YEN|AUD|CAD|CHF|SGD)\b/i.test(
                el.textContent || "",
              ),
          )
          .map((el) => clip(el.textContent, 48)),
      ).slice(0, 16);
      const headings = uniq(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            "h1,h2,h3,h4,[class*=step i],[class*=heading i],[class*=room i] [class*=name i],[class*=rate i] [class*=name i]",
          ),
        )
          .filter(content)
          .map((el) => clip(el.textContent, 44)),
      ).slice(0, 14);
      const inputs = uniq(
        Array.from(document.querySelectorAll<HTMLElement>("input,select"))
          .filter(content)
          .map((el) =>
            clip(
              el.getAttribute("name") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("aria-label") ||
                (el as HTMLInputElement).type,
              28,
            ),
          ),
      ).slice(0, 22);
      return JSON.stringify({
        url: location.href.slice(0, 140),
        headings,
        buttons,
        priced,
        inputs,
      }).slice(0, 4800);
    });
  } catch {
    return "";
  }
}

async function diagnoseGuestForm(page: unknown): Promise<string> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return "";
  try {
    return await cdp.evaluate<string>(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects?.();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // Resolve a field's label the way Angular Material exposes it (no native
      // <label for>): aria-labelledby → referenced <mat-label>, plus the nearest
      // form-field container's label. Without this, Material forms (Agilysys)
      // read as nameless and the diag wrongly returns empty.
      const resolvedLabel = (el: Element): string => {
        let t = "";
        const lb = el.getAttribute("aria-labelledby");
        if (lb)
          for (const id of lb.split(/\s+/))
            if (id) t += " " + (document.getElementById(id)?.textContent || "");
        // Proximity label: smallest container (≤2 inputs) holding this field,
        // first short label-like element — matches what autofill reads.
        let node = (el as HTMLElement).parentElement;
        for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
          if (node.querySelectorAll("input,select,textarea").length > 2) break;
          let l: Element | null = node.querySelector(
            "label,legend,mat-label,[class*=label i]",
          );
          if (!l) {
            l =
              Array.from(node.querySelectorAll("span,div,p,strong,b")).find((e) => {
                if (e.querySelector("input,select,textarea")) return false;
                const tx = (e.textContent || "").replace(/\s+/g, " ").trim();
                return tx.length >= 2 && tx.length <= 28;
              }) ?? null;
          }
          const txt = l?.textContent?.replace(/\s+/g, " ").trim();
          if (txt && txt.length <= 30) {
            t += " " + txt;
            break;
          }
        }
        return t.trim();
      };
      const metaOf = (el: Element): string =>
        [
          el.getAttribute("name"),
          (el as HTMLElement).id,
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          (el as HTMLInputElement).labels?.[0]?.textContent,
          resolvedLabel(el),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>("input,select,textarea"),
      ).filter(vis);
      // Dump a real guest/checkout form. Normally that means a NAME field — but
      // a floating-label form whose labels we can't resolve would read as
      // nameless and dump nothing, which is exactly the case we need to SEE. So
      // also dump when there's a substantial form (≥4 text/email/tel inputs),
      // e.g. a single-page checkout, even with no resolvable name.
      const hasName = controls.some((el) =>
        /first.?name|given-name|last.?name|surname|family-name/.test(metaOf(el)),
      );
      const looksLikeCheckout =
        controls.filter((el) =>
          ["text", "email", "tel"].includes(
            (el.getAttribute("type") || "text").toLowerCase(),
          ),
        ).length >= 4;
      if (!hasName && !looksLikeCheckout) return "";
      const clip = (s: string | null | undefined, n: number) =>
        (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const fields = controls.slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: clip(el.getAttribute("name"), 40),
        id: clip(el.id, 40),
        ph: clip(el.getAttribute("placeholder"), 40),
        aria: clip(el.getAttribute("aria-label"), 40),
        label: clip((el as HTMLInputElement).labels?.[0]?.textContent, 40),
        lby: clip(resolvedLabel(el), 40),
        cls: clip(el.getAttribute("class"), 70),
        req: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        opts:
          el.tagName === "SELECT"
            ? Array.from((el as HTMLSelectElement).options)
                .slice(0, 6)
                .map((o) => clip(o.textContent, 18))
            : undefined,
      }));
      const phoneWidget = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[class*=iti i],[class*=flag i],[class*=country-code i],[class*=countrycode i],[class*=dial i],[class*=phone-prefix i]",
        ),
      )
        .filter(vis)
        .slice(0, 6)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: clip(el.getAttribute("class"), 70),
          txt: clip(el.textContent, 24),
        }));
      const comboboxes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=combobox],[role=listbox],[aria-haspopup=listbox],[class*=dropdown i],[class*=combobox i]",
        ),
      )
        .filter(vis)
        .slice(0, 10)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          cls: clip(el.getAttribute("class"), 70),
          txt: clip(el.textContent, 40),
        }));
      return JSON.stringify({ fields, phoneWidget, comboboxes }).slice(0, 4500);
    });
  } catch {
    return "";
  }
}

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
 * Cheap "is the page still rendering?" probe for the conductor. Samples a DOM
 * signature (readyState + URL + node count) twice ~450ms apart and reports
 * whether anything moved. The reason it exists: luxury booking flows are slow
 * client-rendered SPAs (Aman's `#/booking/step-1`, Villa d'Este, etc.) where
 * each new step — room list, enhancements, guest form — takes several seconds
 * to paint after a Continue click. Without this, the conductor's recognizers
 * read an empty/loading page, match nothing, and the conductor counts a STALL;
 * three of those in ~4s and it quits to the 20s-per-step AI agent BEFORE the
 * deterministic path ever sees the room/guest screens. By treating "DOM still
 * moving" as not-a-stall, the conductor waits for the page to settle and then
 * drives it at ~1.4s/action — the difference between a ~2-minute booking and a
 * 6-minute one. A genuinely novel, settled widget still stalls out fast (the
 * signature is stable), so the agent fallback is unaffected.
 */
/**
 * Resolve the frame that actually holds the booking engine. Many luxury hotels
 * (Gleneagles, and much of SynXis) embed the WHOLE booking flow — calendar,
 * room list, guest form — inside an IFRAME (a <booking-layout> element → iframe).
 * Our deterministic recognizers run page-JS, which by the same-origin policy is
 * BLIND to that iframe's DOM, so the date never clicks (out=PENDING) and the
 * guest form never fills. Playwright can evaluate INSIDE any frame (even
 * cross-origin), so we pick the child frame that contains booking content and
 * run the recognizers there. Returns the PAGE itself when there's no booking
 * iframe (Aman-style same-domain SPA), so non-iframe sites behave exactly as
 * before. The returned object exposes .evaluate — all the content recognizers
 * use — so it's a drop-in for the page.
 */
async function bookingFrame(page: unknown): Promise<unknown> {
  try {
    const p = page as {
      frames?: () => unknown[];
      mainFrame?: () => unknown;
    };
    if (typeof p.frames !== "function") return page;
    const frames = p.frames();
    if (!Array.isArray(frames) || frames.length <= 1) return page;
    const main = typeof p.mainFrame === "function" ? p.mainFrame() : null;
    let best: unknown = null;
    let bestScore = 0;
    for (const f of frames) {
      if (f === main) continue; // skip the outer page
      const fr = f as {
        url?: () => string;
        evaluate?: (fn: () => number) => Promise<number>;
      };
      if (typeof fr.evaluate !== "function") continue;
      const url = (typeof fr.url === "function" ? fr.url() : "") || "";
      // Skip obvious non-booking frames (ads, consent, captcha, analytics).
      if (/google|facebook|doubleclick|analytics|gtm|recaptcha|hcaptcha|consent|cookiebot|onetrust|hotjar|youtube|vimeo/i.test(url)) {
        continue;
      }
      let score = /synxis|sabre|book|reserv|availab|\bibe\b|hotel|stay/i.test(url) ? 3 : 0;
      try {
        const contentScore = await fr.evaluate(() => {
          const has = (sel: string) => !!document.querySelector(sel);
          let s = 0;
          if (has("[role=gridcell],[class*=calendar i],[class*=daypicker i],td[class*=day i]")) s += 3;
          if (has("input[type=tel],input[name*=name i],input[autocomplete*=name i]")) s += 3;
          if (has("[class*=room i],[class*=rate i],[class*=availab i]")) s += 2;
          const txt = (document.body && document.body.innerText) || "";
          if (/check.?in|check.?out|\broom\b|\brate\b|guest|arrival|departure/i.test(txt.slice(0, 4000))) s += 1;
          if (txt.length < 40) s -= 5; // tracking/blank iframe
          return s;
        });
        score += Number(contentScore) || 0;
      } catch {
        /* a cross-origin frame mid-navigation can throw — keep the url score */
      }
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    // Only switch into a frame when it clearly holds booking content.
    return best && bestScore >= 3 ? best : page;
  } catch {
    return page;
  }
}

async function pageStillSettling(page: unknown): Promise<boolean> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return false;
  // \n-delimited so a URL's own "|" can't be mistaken for a field break.
  const probe = async (): Promise<string> => {
    try {
      return await cdp.evaluate<string>(() => {
        // ONLY count VISIBLE spinners. Many sites keep a hidden loader/skeleton
        // node permanently in the DOM; counting those made every settled page
        // look "still loading" forever (a Villa d'Este run waited ~46s on a
        // stable menu before it ever stalled out).
        const spinnerVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return (
            st.visibility !== "hidden" &&
            st.display !== "none" &&
            Number(st.opacity || "1") > 0.05
          );
        };
        const spinners = Array.from(
          document.querySelectorAll(
            '[class*=spinner i],[class*=loading i],[class*=skeleton i],[aria-busy=true]',
          ),
        ).filter(spinnerVisible).length;
        return [
          document.readyState === "complete" ? "1" : "0",
          location.href,
          document.querySelectorAll("*").length,
          spinners,
        ].join("\n");
      });
    } catch {
      return "";
    }
  };
  const a = await probe();
  if (!a) return false;
  await new Promise((r) => setTimeout(r, 450));
  const b = await probe();
  if (!b) return false;
  const pa = a.split("\n");
  const pb = b.split("\n");
  // Genuinely still rendering only if: the doc isn't fully loaded, a VISIBLE
  // spinner is showing, the URL moved (navigation / SPA route change), or the
  // node count shifted by a MEANINGFUL amount. The threshold ignores carousels,
  // clocks, and tooltips that twitch by a node or two on an otherwise static
  // page — those used to read as "settling" and stall the conductor for nothing.
  if (pb[0] !== "1" || (Number(pb[3]) || 0) > 0) return true;
  if (pa[1] !== pb[1]) return true;
  const nodesA = Number(pa[2]) || 0;
  const nodesB = Number(pb[2]) || 0;
  const delta = Math.abs(nodesB - nodesA);
  return delta > 30 || (nodesA > 0 && delta / nodesA > 0.03);
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
  opts?: { excludeSearch?: boolean },
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>((arg: unknown) => {
      const excludeSearch = arg as boolean;
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
      // FORWARD = move to the next step / commit the current one (incl. "Save"
      // on a guest-details sub-form). SEARCH = look up inventory (find rooms /
      // tee times). After a room is chosen, SEARCH is a TRAP: on a two-panel
      // engine (Agilysys) the room-search bar stays on screen, and re-clicking
      // it just re-runs the search instead of going forward — so the caller
      // passes excludeSearch once the room is picked.
      const FORWARD =
        "continue|next|proceed|proceed to checkout|select rate to continue|continue to (guest|details|checkout|payment)|go to (cart|checkout)|view cart|checkout|review|save|save (guest|guest details|details|info|information)|save (and|&) continue|save (and|&) proceed";
      const SEARCH =
        "search( tee times?| availability| rates?)?|check (rates?|availability)|find( tee)? times?|find (a )?rooms?|search rooms?|view rooms?|see rooms?|show rooms?|see availability|update search|view rates?";
      const ADV = excludeSearch
        ? new RegExp(`^(${FORWARD})$`, "i")
        : new RegExp(`^(${SEARCH}|${FORWARD})$`, "i");
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
    }, opts?.excludeSearch ?? false);
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
        /^(search tee times?|search times?|find tee times?|find times?|search availability|check availability|view tee times?|show tee times?|get tee times?|apply|apply filters?|update|update search|refresh|search|find|go)$/i;
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

/**
 * Set the "Players" / party-size step on a golf tee-sheet widget (ChronoGolf,
 * ForeUp, etc.). These engines do NOT show any tee times until the player
 * count is chosen, so a real run sat on the date step forever — the conductor
 * had a date picker and a tee-slot picker but nothing to set Players.
 *
 * The hard part: player options are bare number buttons ("1 2 3 4"), identical
 * to calendar day cells. We disambiguate by POSITION — only count clickable
 * numbers that sit AFTER a "Players" section header and BEFORE the "Tee time"
 * header in document order, which is exactly where the player options live and
 * nowhere the calendar is. Also handles a <select> and the collapsed-accordion
 * case (click the "Players" header to expand, pick the number next tick).
 *
 * Returns a label when it acted ("players=2" / "players-open"), or null when
 * there's no recognisable Players step (so the conductor moves on / hands off).
 */
async function setPlayersCountDeterministically(
  page: unknown,
  want: number | null,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function" || !want || want < 1) return null;
  try {
    return await cdp.evaluate<string | null>(
      (arg: unknown) => {
        const target = (arg as { want: number }).want;
        const isVisible = (el: Element | null): boolean => {
          if (!el) return false;
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return (
            st.visibility !== "hidden" &&
            st.display !== "none" &&
            Number(st.opacity || "1") > 0.05
          );
        };
        const txt = (el: Element): string =>
          ((el as HTMLElement).innerText || el.textContent || "").trim();
        // Locate the "Players" step header and the next section ("Tee time")
        // so we can bound the search to the player options between them. Use a
        // SHORT-text header so we match the accordion label, not a paragraph.
        const headerish = Array.from(
          document.querySelectorAll<HTMLElement>(
            "h1,h2,h3,h4,h5,label,legend,button,a,div,span,li,[role=heading]",
          ),
        ).filter((el) => isVisible(el) && txt(el).length <= 40);
        const playersHdr = headerish.find((el) =>
          /^\s*(players?|golfers?|number of (players|golfers)|how many)\b/i.test(txt(el)),
        );
        if (!playersHdr) return null; // not a players step
        const teeHdr = headerish.find(
          (el) =>
            /tee\s*time|select.*time|choose.*time/i.test(txt(el)) &&
            playersHdr.compareDocumentPosition(el) & 4, // tee header follows players
        );
        const afterPlayers = (el: Element): boolean =>
          (playersHdr.compareDocumentPosition(el) & 4) !== 0; // players precedes el
        const beforeTee = (el: Element): boolean =>
          !teeHdr || (el.compareDocumentPosition(teeHdr) & 4) !== 0; // el precedes tee
        // A <select> for player count — set it directly if present in range.
        const selects = Array.from(
          document.querySelectorAll<HTMLSelectElement>("select"),
        ).filter((s) => isVisible(s) && afterPlayers(s) && beforeTee(s));
        for (const sel of selects) {
          const opt = Array.from(sel.options).find((o) => {
            const n = parseInt((o.textContent || o.value || "").replace(/\D+/g, ""), 10);
            return n === target;
          });
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return `players=${target}`;
          }
        }
        // Clickable number options strictly BETWEEN the two headers. Matches a
        // bare "2" or "2 players" / "2 golfers"; rejects anything longer so we
        // never grab a price or a paragraph.
        const opts = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button,a,li,[role=button],[role=option],[role=radio],div,span",
          ),
        ).filter((el) => {
          if (!isVisible(el) || !afterPlayers(el) || !beforeTee(el)) return false;
          const t = txt(el);
          return /^([1-8])(\s*(players?|golfers?|people|pax))?$/i.test(t);
        });
        const numOf = (el: Element): number =>
          parseInt(txt(el).match(/[1-8]/)?.[0] ?? "0", 10);
        // Prefer the deepest matching element (the actual control, not a wrapper
        // that also contains it) for an exact party-size match.
        const exact = opts
          .filter((el) => numOf(el) === target)
          .sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length)
          .pop();
        if (exact) {
          exact.click();
          return `players=${target}`;
        }
        // Party size not offered (e.g. course max < target) → take the largest
        // available ≤ target, else the smallest offered, so the flow proceeds.
        if (opts.length > 0) {
          const sorted = opts.map(numOf).filter((n) => n >= 1).sort((a, b) => a - b);
          const pick = [...sorted].reverse().find((n) => n <= target) ?? sorted[0];
          const el = opts.find((e) => numOf(e) === pick);
          if (el) {
            el.click();
            return `players=${pick}`;
          }
        }
        // Header found but no options visible yet → the accordion is collapsed.
        // Click the header to expand it; the next tick picks the number.
        const clickable =
          playersHdr.closest<HTMLElement>("button,a,[role=button],[tabindex]") ??
          playersHdr;
        if (isVisible(clickable)) {
          clickable.click();
          return "players-open";
        }
        return null;
      },
      { want },
    );
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
        // A real bookable tee-time card, not a label. Rejects the time-RANGE
        // slider ("7:00 AM–6:00 PM" — two times) that a real run mistook for a
        // 7:00 slot, and the page timestamp; requires a bookable signal (price,
        // players, or a Book/View/Reserve word).
        const looksLikeSlot = (txt: string): boolean => {
          const times = txt.match(/\b\d{1,2}:\d{2}\s*[ap]?\.?m?\.?/gi) || [];
          if (times.length >= 2) return false; // a range / window, not a slot
          return /\$\s?\d|\bplayer|\bbook\b|\breserve\b|\bselect\b|\bview\b|tee\s*time/i.test(
            txt,
          );
        };
        const slots: { el: HTMLElement; min: number }[] = [];
        const seen = new Set<HTMLElement>();
        for (const el of nodes) {
          if (!isVisible(el)) continue;
          const txt = (el.textContent || "").trim();
          if (!txt || txt.length > 140) continue;
          if (!looksLikeSlot(txt)) continue;
          const min = parseMin(txt);
          if (min == null) continue;
          const target = clickTarget(el);
          if (seen.has(target)) continue;
          seen.add(target);
          slots.push({ el: target, min });
        }
        if (slots.length === 0) return null;
        const ascending = [...slots].sort((a, b) => a.min - b.min);
        let chosen = ascending[0];
        if (want != null) {
          // Is the requested time actually offered (within ~45 min of a real
          // slot)? If yes → nearest to it. If NOT (e.g. wanted 7am, earliest is
          // 11:30) → take the SECOND-earliest available (Carson's rule), or the
          // earliest if only one exists.
          const near = ascending.find((s) => Math.abs(s.min - want) <= 45);
          if (near) {
            chosen = [...slots].sort(
              (a, b) => Math.abs(a.min - want) - Math.abs(b.min - want),
            )[0];
          } else {
            chosen = ascending[1] ?? ascending[0];
          }
        }
        chosen.el.click();
        return `slot=${chosen.min}`;
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
      // RESTRICTED rates the customer can't actually use — resident / AAA /
      // AARP / military / government / employee / senior rates that need an ID
      // or proof at check-in. The cheapest rate is often one of these (Streamsong
      // leads with a "Florida/Georgia Resident Rate" that needs a state license),
      // so we must NOT auto-pick it — take the cheapest UNRESTRICTED rate instead.
      const RESTRICTED =
        /\bresident\b|\baaa\b|\baarp\b|military|veteran|government|\bgovt\b|\bemployee\b|\bsenior\b|present your|valid (photo )?id\b|driver'?s licen|corporate rate|first responder|\bnurse\b|\bteacher\b|membership rate|member['’]?s rate/i;
      const seen = new Set<HTMLElement>();
      const rooms: {
        cta: HTMLElement;
        price: number | null;
        book: boolean;
        restricted: boolean;
      }[] = [];
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
        const cardText = card.textContent || "";
        rooms.push({
          cta: chosen,
          price: priceOf(cardText),
          book: !!booking,
          restricted: RESTRICTED.test(cardText),
        });
      }
      // Require a real PRICE on the room. A priceless "room" is almost always
      // a false match on a non-room page (a calendar cell, a nav tab) — that's
      // the "room=first" phantom that clicked the wrong thing on Aman. A real
      // room list shows "from $X/night", so demand one.
      const priced = rooms.filter((r) => r.price != null);
      if (priced.length === 0) return null;
      priced.sort((a, b) => {
        // UNRESTRICTED rates first (a resident/AAA/military rate the customer
        // can't redeem is worse than a pricier rate they can actually book)…
        if (a.restricted !== b.restricted) return a.restricted ? 1 : -1;
        // …then cheapest, then a booking-forward CTA over an info link.
        const pa = a.price ?? Infinity;
        const pb = b.price ?? Infinity;
        if (pa !== pb) return pa - pb;
        return (b.book ? 1 : 0) - (a.book ? 1 : 0);
      });
      priced[0].cta.click();
      return `room=$${priced[0].price}${priced[0].restricted ? " (restricted-only)" : ""}`;
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

      // NEVER treat a CURRENCY selector as a rate. A real golf run picked
      // "U.A.E Dirham" because the fallback grabbed any option when no priced
      // rate was found. Exclude currency names/codes outright.
      const CURRENCY =
        /dirham|dollar|euro\b|pound|peso|yen|rupee|franc|krona|\b(usd|eur|gbp|mxn|aed|cad|aud|jpy|chf|inr)\b|currency/i;
      const usable = opts.filter((o) => !o.membership && !CURRENCY.test(o.text));
      let pool = usable.filter((o) => o.price != null);
      if (pool.length === 0)
        pool = usable.filter((o) =>
          /public|standard|guest|green\s*fee|\brate\b|\d+\s*hole/i.test(o.text),
        );
      // No clearly rate-like option → do NOT guess (prevents the currency /
      // random-option mis-fire). Let the agent handle this step.
      if (pool.length === 0) return null;
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
 * Reveal a COLLAPSED guest-details form. Several checkout engines keep the
 * First/Last/Email inputs hidden behind an "Add Guest" button — Streamsong /
 * Agilysys shows "Guest details (0/2)" with the fields collapsed — so autofill
 * finds nothing and the booking stalls at Proceed with no guest entered. Click
 * "Add Guest" to expand the form. Self-limiting: it only fires when NO guest
 * name field is visible yet, so the instant the fields appear it stops clicking
 * (no runaway row-adding). GENERAL — any "Add Guest"-gated checkout. Best-effort.
 */
async function clickAddGuestDeterministically(page: unknown): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const vis = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects?.();
        if (!r || r.length === 0) return false;
        const s = window.getComputedStyle(el as HTMLElement);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      // Form already open (a name field is on screen)? Nothing to reveal — and
      // this is what stops it re-clicking once the fields appear.
      const nameVisible = Array.from(
        document.querySelectorAll<HTMLInputElement>("input"),
      ).some((el) => {
        if (!vis(el)) return false;
        const m = [
          el.name,
          el.id,
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.labels?.[0]?.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return /first ?name|last ?name|full name|guest name/.test(m);
      });
      if (nameVisible) return null;
      // Find an "Add Guest" control. Icon ligatures can make the text read
      // "add Add Guest", so match the trailing words on short labels only — and
      // never "Add special request".
      const ctrls = Array.from(
        document.querySelectorAll<HTMLElement>("button,a,[role=button]"),
      );
      for (const el of ctrls) {
        if (!vis(el)) continue;
        const t = (
          el.innerText ||
          el.textContent ||
          el.getAttribute("aria-label") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (t.length > 24) continue;
        if (/\badd guests?( details?)?$/.test(t)) {
          el.click();
          return "Add Guest";
        }
      }
      return null;
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
 * EMPTY fields; never touches card fields. After filling text/selects it
 * satisfies any REQUIRED consent selection that would otherwise block the
 * Continue button — an unselected SMS/terms radio group (ResNexus's
 * "TextingOptInSelection") stalled a 9-minute run — picking the affirmative,
 * non-marketing option. Returns how many fields it set. Best-effort, never throws.
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
        // Guard the State value against bad profile data. A street ("107 Lantana
        // Ln") mis-saved in the profile's state field must NEVER be typed into a
        // State/Province box (a real run did exactly that). Accept only a
        // plausible state name — no digits, no street suffix, sane length.
        const stateClean =
          d.state &&
          !/\d/.test(d.state) &&
          !/\b(ln|lane|st|street|rd|road|ave|avenue|blvd|dr|drive|ct|court|way|cir|circle|pl|place|hwy|pkwy|apt|suite|ste|unit)\b/i.test(
            d.state,
          ) &&
          d.state.trim().length >= 2 &&
          d.state.trim().length <= 25
            ? d.state.trim()
            : null;
        const visible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const st = window.getComputedStyle(el as HTMLElement);
          return st.visibility !== "hidden" && st.display !== "none";
        };
        const meta = (el: HTMLElement): string => {
          const parts: (string | null | undefined)[] = [
            el.getAttribute("autocomplete"),
            el.getAttribute("name"),
            el.id,
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            (el as HTMLInputElement).labels?.[0]?.textContent,
          ];
          // aria-labelledby → the referenced label element(s). Angular Material
          // (Agilysys + many hotel engines) gives the <input> no name/placeholder
          // and points it at its <mat-label> this way, so this is the ONLY signal
          // — without it First Name/Email/etc. read as a blank "mat-input-3" and
          // nothing fills.
          const lb = el.getAttribute("aria-labelledby");
          if (lb)
            for (const id of lb.split(/\s+/))
              if (id) parts.push(document.getElementById(id)?.textContent);
          // PROXIMITY LABEL: the label-ish element inside the SMALLEST container
          // that holds this input. Many forms (Agilysys, React, plain HTML) put
          // "First Name" in a bare <label>/<span>/<div> above the field with NO
          // for=/aria association and NO mat-form-field class, so nothing above
          // catches it and the field reads as a blank id. Gate on the container
          // holding ≤2 inputs (so the label is unambiguously THIS field's — a
          // phone "+1" select + number still counts), and take the first short
          // label-like element. GENERAL across form frameworks.
          let node: HTMLElement | null = el.parentElement;
          for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
            if (node.querySelectorAll("input,select,textarea").length > 2) break;
            // Prefer a real label element; fall back to a short-text span/div/p
            // (floating-label engines like iHotelier render "First Name" in a
            // bare <span>, not a <label>). Exclude any element that WRAPS the
            // input — its text would be the whole field, not the label.
            let lbl: Element | null = node.querySelector(
              "label,legend,mat-label,[class*=label i]",
            );
            if (!lbl) {
              lbl =
                Array.from(node.querySelectorAll("span,div,p,strong,b")).find(
                  (e) => {
                    if (e.querySelector("input,select,textarea")) return false;
                    const tx = (e.textContent || "").replace(/\s+/g, " ").trim();
                    return tx.length >= 2 && tx.length <= 28;
                  },
                ) ?? null;
            }
            const txt = lbl?.textContent?.replace(/\s+/g, " ").trim();
            if (txt && txt.length <= 30) {
              parts.push(txt);
              break;
            }
          }
          return parts.filter(Boolean).join(" ").toLowerCase();
        };
        const setVal = (el: HTMLInputElement, val: string) => {
          // Already exactly right → leave it (don't re-type, don't double).
          if ((el.value || "").trim().toLowerCase() === val.trim().toLowerCase()) {
            return;
          }
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          // CLEAR first. An autocomplete/combobox that APPENDS on input is what
          // produced "United StatesUnited States" — clearing forces a clean
          // replace instead of concatenating onto whatever's already there.
          desc?.set?.call(el, "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
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

        // GATE: only fill a real guest/checkout form. A homepage, booking-type
        // chooser, or footer can carry a stray newsletter email or a search box
        // whose meta matches — filling those is wrong (a Villa d'Este run logged
        // "autofill 3 fields" on the chooser page) and can trip validation. The
        // hallmark of a guest form is a NAME field (first/last) or a card field,
        // or an email AND phone together (newsletters ask one, not both). No
        // such signal → fill nothing.
        const allInputs = Array.from(
          document.querySelectorAll<HTMLInputElement>("input"),
        );
        const anyMeta = (re: RegExp): boolean =>
          allInputs.some((el) => re.test(meta(el)));
        const anyType = (t: string): boolean =>
          allInputs.some(
            (el) => (el.getAttribute("type") || "").toLowerCase() === t,
          );
        const hasName = anyMeta(
          /given-name|first.?name|\bfname\b|family-name|last.?name|surname|\blname\b/,
        );
        const hasCard = anyMeta(/cc-?number|card.?number|cardnumber|credit.?card|\bpan\b/);
        const hasEmail = anyType("email") || anyMeta(/\be-?mail\b/);
        const hasPhone = anyType("tel") || anyMeta(/phone|mobile|\btel\b/);
        if (!hasName && !hasCard && !(hasEmail && hasPhone)) return 0;
        // Skip a NEWSLETTER / subscribe form. Streamsong's reservations page has
        // a "Stay Current on Everything Streamsong" signup (First / Last / Email
        // + terms) that passed the name gate above and got auto-filled as if it
        // were the guest form. A REAL checkout also has a card field, a phone,
        // OR an address — a newsletter has none of those, just a Subscribe-type
        // control nearby. Only skip when that's unmistakable.
        const hasAddr = anyMeta(
          /address|street|postal|\bzip\b|\bcity\b|\bstate\b|country/,
        );
        const subscribeCtx = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button,input[type=submit],a,h1,h2,h3,h4,legend",
          ),
        ).some((b) =>
          /subscribe|sign\s?up for|stay current|newsletter|join (our|the).*(list|club)|get (our )?updates|email (sign|list)/i.test(
            (
              (b as HTMLElement).innerText ||
              (b as HTMLInputElement).value ||
              b.textContent ||
              ""
            ).trim(),
          ),
        );
        if (subscribeCtx && !hasCard && !hasPhone && !hasAddr) return 0;

        for (const el of inputs) {
          const m = meta(el);
          // NEVER touch payment fields.
          if (/card|cc-|cvc|cvv|expir|pan\b/.test(m)) continue;
          // NEVER fill a confirmation / reservation NUMBER field — we don't have
          // one, and its label often contains "…email" (Sea Island's golf gate:
          // "confirmation number from your confirmation email"), which the
          // confirm-email rule below would otherwise wrongly grab the email for.
          if (
            /confirmation\s*(number|code|no\b|#)|reservation\s*(number|code|#)|booking\s*(number|reference|code)|record\s*locator|conf(irmation)?\s*#/i.test(
              m,
            )
          ) {
            continue;
          }
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (/given-name|first.?name|\bfname\b/.test(m)) setVal(el, d.firstName);
          else if (/family-name|last.?name|surname|\blname\b/.test(m)) setVal(el, d.lastName);
          else if (/confirm.*(e-?mail)|(e-?mail).*(confirm|verify|repeat)/.test(m)) setVal(el, d.email);
          else if (type === "email" || /\be-?mail\b/.test(m)) setVal(el, d.email);
          else if (type === "tel" || /phone|mobile|\btel\b/.test(m)) {
            // A SEPARATE country/dial-code control next to the field (intl-tel-
            // input flag, a "+44" Code box — Gleneagles, Aman) wants only the
            // NATIONAL digits; a US "+1…" dumped in alongside reads as invalid
            // ("+44 +19038206837"). Climb a few ancestors looking for a flag/
            // dial/iti control SPECIFICALLY — not the address "Country" select.
            let scope: Element = el;
            for (let i = 0; i < 4 && scope.parentElement; i++) scope = scope.parentElement;
            const hasCountrySel = !!scope.querySelector(
              "[class*=flag i],[class*=iti i],[class*=dial i],[class*=country-code i],[class*=countrycode i],[class*=phone-prefix i],select[name*=code i]",
            );
            setVal(el, hasCountrySel ? d.phoneNational : d.phone);
          } else if (d.addressLine1 && /address-line1|address.?(line)?.?1\b|street|\baddr/.test(m) && !/address.?2|addr.?2|line.?2|address.?line.?2/.test(m)) setVal(el, d.addressLine1);
          else if (d.city && /\bcity\b|\btown\b|locality/.test(m)) setVal(el, d.city);
          else if (stateClean && /state|province|region|county\b/.test(m) ) setVal(el, stateClean);
          else if (d.postal && /\bzip\b|postal|post.?code/.test(m)) setVal(el, d.postal);
          else if (d.countryName && /^country|\bcountry\b|country-name/.test(m)) setVal(el, d.countryName);
          else if (/prefix|salutation|honorific|^title$|\btitle\b/.test(m) && /title|prefix|salutation/.test(m)) setVal(el, d.title);
        }

        // ACCOUNT-CREATION passwords. Some golf platforms (ChronoGolf visitors,
        // TeeSnap) FORCE creating an account to book — a "Create an account" form
        // with Password + Repeat-password. The customer authorized the booking,
        // so we create the account on their behalf rather than stall: generate
        // ONE strong password (meets the common "12+ chars" rule) and put it in
        // BOTH password fields. A per-booking credential — the venue's
        // confirmation email lets the customer reset it. Only on a real signup
        // (>=2 password fields = password + confirm), never a 1-field login (we
        // have no existing account, so a login would just fail).
        const pwFields = Array.from(
          document.querySelectorAll<HTMLInputElement>("input[type=password]"),
        ).filter((el) => visible(el) && !el.value && !el.disabled && !el.readOnly);
        if (pwFields.length >= 2) {
          const pw = `Pyltrix-${Math.random().toString(36).slice(2, 10)}9!Aa`;
          for (const el of pwFields) setVal(el, pw);
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
          else if (stateClean && /state|province|region/.test(m)) pick(el, stateClean);
        }

        // PHONE DIAL-CODE → US (+1). intl-tel-input (the dominant phone widget)
        // and lookalikes default the code to the SITE's locale (+44 on
        // Gleneagles, +49 on Aman) — which invalidates a US number even with the
        // national digits. Targets intl-tel-input's exact markup, so it cleanly
        // no-ops on other libraries: open the flag dropdown, pick United States.
        try {
          const itiFlag = document.querySelector<HTMLElement>(
            ".iti__selected-flag, .iti__selected-country, [class*=iti i] [class*=flag i]",
          );
          const itiList = document.querySelector(
            ".iti__country-list, .iti__dropdown-content, [class*=iti i] [class*=country-list i]",
          );
          if (itiFlag && itiList && visible(itiFlag)) {
            const cur = (itiFlag.getAttribute("title") || itiFlag.textContent || "").toLowerCase();
            if (!/united states|\(\+1\)|\bus\b/.test(cur)) {
              itiFlag.click(); // open the country list
              const us = itiList.querySelector<HTMLElement>(
                "li[data-country-code='us'], [data-country-code='us'], li[data-dial-code='1']",
              );
              if (us) {
                us.click();
                filled++;
              }
            }
          }
        } catch {
          /* best-effort — never break the rest of the fill */
        }

        // CUSTOM dropdowns (NOT native <select>): the One&Only "STATE OR COUNTY
        // / CHOOSE STATE" field is a searchable combobox — a real run lost
        // ~1-2 min scrolling it. If an option list is open and visible, click
        // the option whose text EXACTLY matches our state or country. Exact
        // full-name match keeps this from mis-clicking anything else.
        const wantOptions = [stateClean, d.countryName]
          .filter(Boolean)
          .map((s) => (s as string).toLowerCase());
        if (wantOptions.length > 0) {
          const optionEls = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[role=option],[role=listbox] li,ul[class*=option i] li,[class*=dropdown i] li,[class*=menu i] li,li[class*=option i]",
            ),
          ).filter((el) => visible(el));
          for (const el of optionEls) {
            const t = (el.textContent || "").trim().toLowerCase();
            if (!t || t.length > 40) continue;
            if (wantOptions.includes(t)) {
              el.click();
              filled++;
              break; // one combobox selection per pass
            }
          }
        }

        // ── REQUIRED CONSENT / COMMUNICATION SELECTIONS ──────────────────
        // The text fill above leaves radios + checkboxes alone, but a REQUIRED
        // consent group BLOCKS the Continue button. ResNexus's
        // "TextingOptInSelection" ("I agree to receive important reservation
        // information via text" / "Do not send…") stalled a 9-minute run
        // because nothing selected it. Satisfy these so the form advances. We
        // already passed the guest-form gate, and we ONLY touch consent-ish
        // groups (communication prefs / terms / age) — never a meaningful
        // choice like room or rate — so it's safe and GENERAL across engines.
        const consentRe =
          /text|sms|e-?mail|phone|call|contact|communicat|marketing|promotion|newsletter|opt.?in|opt.?out|consent|agree|terms|conditions|privacy|policy|reservation\s*information|receive|notify|do not send|important/i;
        const marketingRe =
          /marketing|promotion|newsletter|special\s*offers?|third.?part|advertis/i;
        const consentMeta = (el: HTMLElement): string =>
          `${el.getAttribute("name") || ""} ${el.id || ""} ${meta(el)}`.toLowerCase();
        // click() drives the native toggle + fires the events React/jQuery
        // listen to; a follow-up change covers vanilla change-only handlers.
        const fireToggle = (el: HTMLInputElement) => {
          el.click();
          el.dispatchEvent(new Event("change", { bubbles: true }));
          filled++;
        };

        // Radio groups: select ONE option in any UNSELECTED consent group.
        const allRadios = Array.from(
          document.querySelectorAll<HTMLInputElement>("input[type=radio]"),
        ).filter((el) => visible(el) && !el.disabled);
        const radioGroups = new Map<string, HTMLInputElement[]>();
        for (const r of allRadios) {
          const key = r.name || r.id || "";
          if (!radioGroups.has(key)) radioGroups.set(key, []);
          radioGroups.get(key)!.push(r);
        }
        for (const group of radioGroups.values()) {
          if (group.some((r) => r.checked)) continue; // already satisfied
          const groupText = group.map(consentMeta).join(" ");
          if (!consentRe.test(groupText)) continue; // not a consent group → skip
          const isMarketingGroup = marketingRe.test(groupText);
          // Score each option so we pick the affirmative TRANSACTIONAL choice
          // (so the customer still gets their reservation texts) but NEVER opt
          // into marketing — for a marketing-only group, pick the decline.
          const scored = group.map((r) => {
            const t = consentMeta(r);
            let s = 0;
            if (marketingRe.test(t)) s -= 5;
            if (/\bi agree\b|agree to|\byes\b|receive (important|reservation|booking|your)/.test(t)) s += 3;
            if (/important|reservation\s*information|transactional/.test(t)) s += 2;
            if (/do not|don.?t|decline|opt.?out|unsubscribe/.test(t))
              s += isMarketingGroup ? 3 : -1;
            return { r, s };
          });
          scored.sort((a, b) => b.s - a.s);
          if (scored[0]) fireToggle(scored[0].r);
        }

        // Checkboxes: tick REQUIRED terms/age/consent boxes (never marketing);
        // leave optional + marketing boxes exactly as the page set them.
        const allChecks = Array.from(
          document.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
        ).filter((el) => visible(el) && !el.disabled && !el.checked);
        for (const c of allChecks) {
          const required =
            c.hasAttribute("required") || c.getAttribute("aria-required") === "true";
          const t = consentMeta(c);
          const looksRequiredConsent =
            /terms|conditions|privacy|policy|\bage\b|\b18\b|older|i agree|i accept|acknowledge|cancellation\s*policy|consent/.test(
              t,
            );
          if ((required || looksRequiredConsent) && !marketingRe.test(t)) {
            fireToggle(c);
          }
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
/**
 * Detect a RESORT-GUEST golf gate that requires an existing HOTEL booking to
 * proceed (Sea Island: "Enter the confirmation number from your Sea Island
 * confirmation email" + "last name under which the room reservation was made").
 * We can't satisfy this standalone — the customer's stay has to be booked first
 * — so bail with a message that routes it to the concierge to book WITH the
 * stay, instead of mis-filling the gate and looping. Returns the message or null.
 */
async function detectResortConfirmationGate(page: unknown): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const body = (document.body?.innerText || "").toLowerCase();
      const gate =
        /confirmation number from your[\s\S]{0,40}(confirmation|reservation)[\s\S]{0,12}email|last name under which the room reservation|enter (the )?confirmation number from your|reservation confirmation number|number from your .{0,20}confirmation email/.test(
          body,
        );
      if (!gate) return null;
      return "This resort books tee times only for confirmed guests — it asks for your room confirmation number. Our concierge will reserve your tee times together with your resort stay.";
    });
  } catch {
    return null;
  }
}

/**
 * Detect that the REQUESTED check-in date is sold out / unavailable on the
 * booking calendar (Streamsong shows "Sold out" on Aug 10), so we surface
 * no_availability instead of spinning. CONSERVATIVE: requires the calendar to
 * be showing the target month+year AND the exact target-day cell to be marked
 * sold-out/unavailable — so it never mis-fires on some OTHER date being full.
 */
async function detectRequestedDatesSoldOut(
  page: unknown,
  checkinISO: string,
): Promise<boolean> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function" || !checkinISO) return false;
  try {
    return await cdp.evaluate<boolean>(
      (arg: unknown) => {
        const iso = (arg as { iso: string }).iso;
        const [ty, tm, td] = iso.split("-").map((n) => parseInt(n, 10));
        const MONTHS = [
          "january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december",
        ];
        const targetMonth = MONTHS[tm - 1];
        const isVisible = (el: Element): boolean => {
          const r = (el as HTMLElement).getClientRects();
          if (!r || r.length === 0) return false;
          const s = window.getComputedStyle(el as HTMLElement);
          return s.visibility !== "hidden" && s.display !== "none";
        };
        // The calendar must be SHOWING the target month+year, so a sold-out
        // target-day cell is really the requested date (not another month).
        const monthShown = Array.from(
          document.querySelectorAll<HTMLElement>("*"),
        ).some((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          return (
            t.length < 25 &&
            t.includes(targetMonth) &&
            t.includes(String(ty)) &&
            isVisible(el)
          );
        });
        if (!monthShown) return false;
        const cells = Array.from(
          document.querySelectorAll<HTMLElement>(
            "td,button,div,a,li,[role=gridcell]",
          ),
        );
        for (const c of cells) {
          if (!isVisible(c)) continue;
          const txt = (c.textContent || "").trim();
          if (txt.length > 40) continue;
          const m = txt.match(/^(\d{1,2})\b/);
          if (!m || parseInt(m[1], 10) !== td) continue;
          // Pikaday trailing day? skip cells whose data-pika-month ≠ target.
          const pk = c.querySelector?.("[data-pika-day]") ?? c;
          const pm = (pk as HTMLElement).getAttribute?.("data-pika-month");
          if (pm != null && parseInt(pm, 10) !== tm - 1) continue;
          const soldOut =
            /sold\s*out|unavailable|not\s*available|no\s*availability|fully\s*booked/i.test(
              txt,
            ) ||
            /sold|unavailable|disabled|not-?available/i.test(c.className || "") ||
            c.getAttribute("aria-disabled") === "true";
          if (soldOut) return true;
        }
        return false;
      },
      { iso: checkinISO },
    );
  } catch {
    return false;
  }
}

/**
 * Detect a golf tee sheet that clearly has NO tee times available for the
 * chosen date, so we surface "no availability" (and let the swap-to-a-nearby-
 * course flow run) instead of spinning "finding your time…" forever. Runs
 * AFTER the conductor has set the date + clicked Apply, so a "No Results" here
 * is genuine (not just an un-applied date). CONSERVATIVE: only fires on an
 * explicit no-times message AND when no bookable slot is actually present.
 */
async function detectNoTeeAvailability(page: unknown): Promise<boolean> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return false;
  try {
    return await cdp.evaluate<boolean>(() => {
      const body = (document.body?.innerText || "").toLowerCase();
      const noTimes =
        /no\s+(tee\s+)?times?\s+(are\s+)?available|there\s+are\s+no\s+tee\s+times|no\s+results|sold\s+out|fully\s+booked|no\s+available\s+times|no\s+times\s+(were\s+)?found/.test(
          body,
        );
      if (!noTimes) return false;
      // If a real bookable slot is on the page, it's NOT a no-availability page.
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("a,button,[role=button],li,tr,div"),
      );
      const hasSlot = nodes.some((el) => {
        const t = (el.textContent || "").trim();
        if (!t || t.length > 120) return false;
        const times = t.match(/\b\d{1,2}:\d{2}\s*[ap]?\.?m?\.?/gi) || [];
        return times.length === 1 && /\$\s?\d|\bbook\b|\breserve\b|\bselect\b/i.test(t);
      });
      return !hasSlot;
    });
  } catch {
    return false;
  }
}

/**
 * Detect a clearly PRIVATE / members-only golf club with NO public booking
 * path, so a golf run bails fast (with a customer-facing message) instead of
 * sitting on a members showcase for minutes (a real run sat 2.5 min on
 * Watersound Club). CONSERVATIVE — only fires when BOTH hold:
 *   1) a STRONG private signal (Member-Login + Membership nav, or explicit
 *      "members only / private club / not open to the public" text), AND
 *   2) ZERO golf-booking widgets anywhere (no calendar, no date input, no
 *      tee-time/availability CTA, no known tee-sheet host).
 * So a public or semi-private course with ANY real booking path is never
 * bailed. Returns a customer message, or null.
 */
async function detectPrivateGolfClub(page: unknown): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const host = location.host.toLowerCase();
      // A known tee-sheet engine = definitely bookable → never private-bail.
      if (
        /chronogolf|foreupsoftware|teesnap|cps\.golf|golfnow|teeoff|golfwithaccess|quick18|sagacity|golfback|teeon|teequest|ezlinks/.test(
          host,
        )
      ) {
        return null;
      }
      const bodyText = (document.body?.innerText || "").toLowerCase();
      const navText = Array.from(
        document.querySelectorAll<HTMLElement>(
          "nav a, header a, [role=navigation] a, [class*=nav i] a",
        ),
      ).map((a) => (a.textContent || "").trim().toLowerCase());
      const hasMemberLogin = navText.some((t) =>
        /member\s*login|members?\s*area|members?\s*portal/.test(t),
      );
      const hasMembership =
        navText.some((t) => /^membership$|join the club|become a member/.test(t)) ||
        /\bmembership\b/.test(bodyText.slice(0, 5000));
      const privatePhrase =
        /members?\s*only|members?\s+and\s+(their\s+)?(invited\s+)?guests|private\s+(members'?\s+)?club|not\s+open\s+to\s+the\s+public|registered\s+(resort\s+)?guests?\s+only|must\s+be\s+a\s+member|for\s+members\s+and\s+their/.test(
          bodyText,
        );
      const strongPrivate = (hasMemberLogin && hasMembership) || privatePhrase;
      if (!strongPrivate) return null;
      // ANY golf-booking path present → NOT a dead end; let the agent try.
      if (
        document.querySelector(
          "[data-pika-day],[role=gridcell],.pika-button,[class*=teetime i],[class*=tee-time i]",
        )
      ) {
        return null;
      }
      const inputs = Array.from(document.querySelectorAll("input"));
      if (
        inputs.some((i) =>
          /date/i.test(
            (i.getAttribute("type") || "") +
              (i.getAttribute("name") || "") +
              (i.getAttribute("placeholder") || ""),
          ),
        )
      ) {
        return null;
      }
      const ctas = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, [role=button]"),
      ).map((e) => (e.textContent || "").trim().toLowerCase());
      const TEE =
        /book a tee time|tee times?|reserve a tee time|check availability|book your tee time|golf reservations?|book a round/;
      if (ctas.some((t) => t.length < 40 && TEE.test(t))) return null;
      // Strong private + no booking path anywhere → genuinely unbookable.
      const phone = (bodyText.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/) || [])[0] || null;
      return `This course is private — only members and resort guests can play, so the public can't book a tee time here${phone ? ` (pro shop: ${phone})` : ""}. Stay at the resort to play it, or our concierge can grab a nearby course you can book.`;
    });
  } catch {
    return null;
  }
}

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

/**
 * Click the HOTEL-STAY option on a "What would you like to book?" chooser.
 * Luxury properties with multiple bookable services (Villa d'Este: hotel /
 * villa / table / treatment / event; many SynXis + resort engines do the same)
 * interpose a booking-TYPE chooser the instant you click "Book now", BEFORE the
 * calendar. The generic Book-CTA recognizer just re-clicks "Book now" and the
 * conductor stalls on the chooser; this picks the rooms/stay option so the flow
 * proceeds. GENERAL, not a per-site patch: it keys on meaning (a list of
 * "book a <thing>" options) and scores hotel/room/stay above villa, and
 * hard-skips dining/spa/event/meeting. Only fires on a REAL chooser (≥2 visible
 * booking-type options) so it can't mis-fire on an ordinary page that merely
 * has a stray "Book a table" link. Returns the clicked label, or null.
 */
/**
 * Click the VISITOR / GUEST / PUBLIC tab on a booking widget that splits
 * visitors vs members (ChronoGolf: "Visitors" | "Members"). The customer is a
 * public visitor and must NOT be left on the Members tab, which forces a member
 * login they don't have. Only fires when BOTH a guest-ish and a member-ish tab
 * are present (a real chooser). Returns the clicked label, "already-visitors"
 * when the guest tab is already active, or null when there's no such chooser.
 */
async function clickGuestTabDeterministically(page: unknown): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      const isVisible = (el: Element): boolean => {
        const r = (el as HTMLElement).getClientRects();
        if (!r || r.length === 0) return false;
        const st = window.getComputedStyle(el as HTMLElement);
        return (
          st.visibility !== "hidden" &&
          st.display !== "none" &&
          Number(st.opacity || "1") > 0.05
        );
      };
      const txt = (el: HTMLElement) =>
        (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
      const tabs = Array.from(
        document.querySelectorAll<HTMLElement>("[role=tab], button, a, li, [class*=tab i]"),
      ).filter(isVisible);
      const GUEST = /^(visitors?|guests?|public|non[-\s]?members?)$/i;
      const MEMBER = /^(members?|log\s?in|login|sign\s?in|member login)$/i;
      const guestTab = tabs.find((el) => GUEST.test(txt(el)));
      const memberTab = tabs.find((el) => MEMBER.test(txt(el)));
      if (!guestTab || !memberTab) return null; // not a visitor/member chooser
      const active = (el: HTMLElement) =>
        el.getAttribute("aria-selected") === "true" ||
        el.getAttribute("aria-current") === "true" ||
        /\b(active|selected|current)\b/i.test(el.className);
      if (active(guestTab)) return "already-visitors";
      guestTab.click();
      return txt(guestTab);
    });
  } catch {
    return null;
  }
}

async function clickBookingTypeChooserDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
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
      const labelOf = (el: HTMLElement): string =>
        (el.innerText || el.textContent || el.getAttribute("aria-label") || "")
          .trim()
          .replace(/\s+/g, " ");
      // A bookable NOUN (what you can book) and a BOOK verb. An option needs
      // both to count, so plain nav links ("Rooms", "Spa") aren't options.
      const BOOK_VERB = /\b(book|reserve|prenota|réserv|reservar|buchen|plan)\b/i;
      const STAY =
        /\b(stay|room|rooms|suite|suites|accommodation|overnight|hotel)\b/i;
      const OTHER =
        /\b(table|dining|restaurant|breakfast|lunch|dinner|treatment|spa|massage|wellness|event|meeting|wedding|conference|gift|voucher|experience|tour|excursion|class|villa)\b/i;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          "a, button, [role=button], [role=option], [role=menuitem], li, [class*=option i], [class*=choice i], [class*=tile i], [class*=card i]",
        ),
      );
      const seen = new Set<string>();
      const options: { el: HTMLElement; txt: string }[] = [];
      for (const el of nodes) {
        const txt = labelOf(el);
        if (!txt || txt.length > 48) continue;
        const low = txt.toLowerCase();
        if (seen.has(low)) continue;
        if (!BOOK_VERB.test(txt) || !(STAY.test(txt) || OTHER.test(txt))) continue;
        if (!isVisible(el)) continue;
        seen.add(low);
        options.push({ el, txt });
      }
      // Only act on a real chooser: ≥2 distinct booking-type options.
      if (options.length < 2) return null;
      // Score: hotel/room/suite stay wins; dining/spa/event/villa are skipped.
      const score = (txt: string): number => {
        if (OTHER.test(txt) && !/\bhotel\b|\broom|\bsuite/i.test(txt)) return -1;
        let s = 0;
        if (/\bhotel\b/i.test(txt)) s += 3;
        if (/\broom|\bsuite/i.test(txt)) s += 3;
        if (/\bstay|accommodation|overnight\b/i.test(txt)) s += 2;
        return s;
      };
      let best: { el: HTMLElement; txt: string } | null = null;
      let bestScore = 0;
      for (const o of options) {
        const s = score(o.txt);
        if (s > bestScore) {
          bestScore = s;
          best = o;
        }
      }
      if (!best || bestScore <= 0) return null;
      // The matched node may be a wrapper (a <li>/card) around the real link —
      // click the inner anchor/button so the navigation actually fires.
      const target: HTMLElement = best.el.matches("a, button")
        ? best.el
        : ((best.el.querySelector("a, button") as HTMLElement | null) ?? best.el);
      if (target instanceof HTMLAnchorElement) target.target = "_self";
      target.click();
      return best.txt;
    });
  } catch {
    return null;
  }
}

async function clickBookingEntryDeterministically(
  page: unknown,
  entryOpts?: { golf?: boolean },
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>((arg: unknown) => {
      const { golf } = arg as { golf: boolean };
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
      // GOLF-specific entry CTAs — unambiguous tee-time bookings, safe on any
      // golf task. A resort's ROOM "Book Now" is deliberately NOT in here.
      const GOLF_CTA =
        /^(book a tee time|book tee times?|tee times?|reserve a tee time|reserve tee times?|book golf|book a round|book your round|golf booking|golf reservations?|book your tee time|tee time booking)$/i;
      // Choose which CTAs we're willing to click:
      //  - GOLF task on a RESORT / non-golf page: a generic "Book Now"/"Reserve"
      //    books a ROOM, not golf — clicking it wastes the run (Carson's exact
      //    complaint). Take ONLY an explicit golf CTA here; the golf-section
      //    navigator handles drilling into the tee sheet. GENERAL — every site.
      //  - On a GOLF-context page (a course's OWN site), "Book Now" IS the
      //    tee-time booking, so allow the generic CTAs too (some courses put
      //    "Book Now" right on the golf page — click it).
      //  - HOTEL task: unchanged.
      const tiers: RegExp[] =
        golf && !isGolfContext
          ? [GOLF_CTA]
          : isGolfContext
            ? [GOLF_CTA, PRIMARY, SECONDARY, GOLF_DEEPER]
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
    }, { golf: !!entryOpts?.golf });
  } catch {
    return null;
  }
}

/**
 * GOLF-only navigator: on a resort/marketing page, drill toward the tee-time
 * booking by clicking the most golf-specific nav link available. Because we
 * only call this for KNOWN golf bookings, clicking a "Golf" / "Tee Times" link
 * is always correct, so these take priority over a generic hotel "Book Now"
 * (which on a resort homepage would book a ROOM, not a round). One hop per call:
 *   tee-time link  →  Golf section  →  Activities/Experiences (golf hides here)
 * Returns the clicked label, or null when there's nothing to navigate (e.g. we
 * already reached the tee sheet — a calendar/known engine is present).
 */
async function clickGolfSectionDeterministically(
  page: unknown,
): Promise<string | null> {
  const cdp = page as CdpPage;
  if (typeof cdp?.evaluate !== "function") return null;
  try {
    return await cdp.evaluate<string | null>(() => {
      // Already at the tee sheet? A known engine host or a live calendar means
      // navigation is done — let the date/players/slot recognizers drive.
      const host = location.host.toLowerCase();
      if (
        /chronogolf|foreupsoftware|teesnap|cps\.golf|golfnow|teeoff|golfwithaccess|quick18|sagacity|golfback|teeon|teequest|ezlinks|foretees/.test(
          host,
        )
      ) {
        return null;
      }
      if (
        document.querySelector(
          "[data-pika-day], [role=gridcell], .pika-button, [class*=teetime i], [class*=tee-time i]",
        )
      ) {
        return null;
      }
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
      const labelOf = (el: HTMLElement): string =>
        (el.innerText || el.textContent || el.getAttribute("aria-label") || "")
          .trim()
          .replace(/^[\s›»→⟶▶‹«←◀<>·•|]+|[\s›»→⟶▶‹«←◀<>·•|]+$/g, "")
          .trim();
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, [role=button]"),
      );
      // Most-specific → least. Tee-time booking link beats a generic "Golf"
      // section, which beats an "Activities"/"Experiences" hub (golf often
      // lives one level under those on resort sites).
      const TEE =
        /^(book a tee time|tee times?|reserve a tee time|reserve tee times?|golf reservations?|book golf|book a round|book your tee time|tee time booking|reserve your tee time|golf booking|book your round)$/i;
      const GOLF =
        /^(golf|play golf|golf courses?|the golf|golf course|golf club|championship golf|golf & .*|golf and .*|the courses?)$/i;
      const ACT =
        /^(activities|experiences|recreation|things to do|land pursuits|sports (&|and) recreation|resort activities|play|pursuits)$/i;
      for (const re of [TEE, GOLF, ACT]) {
        for (const el of nodes) {
          const txt = labelOf(el);
          if (!txt || txt.length > 40) continue;
          if (re.test(txt) && isVisible(el)) {
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

/**
 * Close a BLOCKING info/promo MODAL that sits over the page and intercepts
 * clicks — the general version of the cookie dismisser. Real hotels throw all
 * kinds of these (Sea Island's "Rate Availability" popup, newsletter signups,
 * "welcome" overlays); the agent used to sit on them for minutes without
 * clicking the X. Runs every tick on every site, so the fix cascades.
 *
 * STRONGLY guarded so it can NEVER close a real booking step:
 *   - only a visible fixed/absolute OVERLAY of meaningful size,
 *   - that has a clear close affordance (X / Close / Got it / Dismiss),
 *   - and contains NO form inputs and NO booking-action button
 *     (Book/Reserve/Continue/Select/Search…) — i.e. it's purely informational.
 * Returns the clicked label, or null.
 */
async function dismissBlockingModalDeterministically(
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
        return (
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          Number(s.opacity || "1") > 0.05
        );
      };
      const modals = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=dialog],[aria-modal=true],[class*=modal i],[class*=popup i],[class*=lightbox i],[class*=overlay i]",
        ),
      ).filter(isVisible);
      for (const modal of modals) {
        const rect = modal.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 100) continue;
        const st = window.getComputedStyle(modal);
        if (st.position !== "fixed" && st.position !== "absolute") continue;
        // NEVER close a booking step: skip if it holds form inputs…
        if (
          modal.querySelector(
            "input:not([type=hidden]):not([type=button]):not([type=submit]),select,textarea",
          )
        ) {
          continue;
        }
        // …or a booking-action button (this is a step, not an info popup).
        const actionable = Array.from(
          modal.querySelectorAll<HTMLElement>("button,a,[role=button]"),
        );
        const hasBookingAction = actionable.some((b) => {
          const t = (b.textContent || "").trim();
          return (
            t.length < 30 &&
            /\b(book|reserve|continue|select|confirm|add to|checkout|proceed|next|search|apply|view rooms?|view rates?|choose)\b/i.test(
              t,
            )
          );
        });
        if (hasBookingAction) continue;
        // Find a close affordance inside the modal and click it.
        const CLOSE_TXT =
          /^(×|✕|✖|x|close|close\s*x|got it|dismiss|no thanks?|maybe later|i understand|okay|ok)$/i;
        const candidates = Array.from(
          modal.querySelectorAll<HTMLElement>(
            "button,a,[role=button],[aria-label],span,i,svg",
          ),
        );
        for (const c of candidates) {
          if (!isVisible(c)) continue;
          const txt = (c.textContent || "").trim();
          const aria = (c.getAttribute("aria-label") || "").trim();
          const cls = (c.getAttribute("class") || "").toString();
          if (
            (txt.length <= 12 && CLOSE_TXT.test(txt)) ||
            /\bclose\b|dismiss/i.test(aria) ||
            /(^|[-_ ])(close|modal-close|btn-close|dialog-close|close-btn|closebutton)([-_ ]|$)/i.test(
              cls,
            )
          ) {
            c.click();
            return (txt || aria || "close").slice(0, 20);
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
