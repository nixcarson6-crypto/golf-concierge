/**
 * Golf booking PLATFORM specialization.
 *
 * Almost all bookable online golf runs through a small set of tee-sheet
 * platforms with CONSISTENT booking flows. Detecting the platform (by the
 * booking URL/host) lets us hand the agent a tight, platform-specific flow hint
 * — so it takes 3-4 sure steps instead of 16 exploratory ones — and lets the
 * conductor apply platform-tuned fast-paths. Flows researched June 2026 from
 * each vendor's own support docs / live widgets:
 *
 *  - ChronoGolf / Lightspeed (chronogolf.com|.ca, /club/<id>/widget): VISITORS
 *    tab → Date → holes → Players → Tee time → confirm. No login for visitors.
 *  - ForeUp (foreupsoftware.com/booking/<id>): Public Reservations → date/players
 *    → Search → slot → details → Book Time. Pay-at-course (no card) common.
 *  - TeeSnap (*.teesnap.net): date/holes/players/cart → RESERVE → LOGIN REQUIRED
 *    → finalize → pay. Cannot finish without an account.
 *  - GolfNow / TeeOff (golfnow.com, teeoff.com): aggregator; guest checkout
 *    (card) or login. Search → time → players → checkout.
 *  - Club Prophet (*.cps.golf): online reservation engine.
 *  - Troon Access (golfwithaccess.com): Date → Search → slot → PUBLIC rate →
 *    confirm.
 *  - Quick18 / Sagacity (quick18.com), GolfBack (golfback.com), Tee-On
 *    (teeon.com), EZLinks / TeeQuest, ForeTees (foretees.com — PRIVATE/members).
 */

export type GolfPlatform =
  | "chronogolf"
  | "foreup"
  | "teesnap"
  | "golfnow"
  | "teeoff"
  | "troon-access"
  | "clubprophet"
  | "quick18"
  | "golfback"
  | "teeon"
  | "ezlinks"
  | "foretees";

const PLATFORM_HOSTS: { match: RegExp; platform: GolfPlatform }[] = [
  { match: /chronogolf\.(com|ca)|lightspeed.*golf|golf.*lightspeed/i, platform: "chronogolf" },
  { match: /foreupsoftware\.com|\bforeup\b/i, platform: "foreup" },
  { match: /\bteesnap\.(net|com)/i, platform: "teesnap" },
  { match: /golfnow\.com/i, platform: "golfnow" },
  { match: /teeoff\.com/i, platform: "teeoff" },
  { match: /golfwithaccess\.com/i, platform: "troon-access" },
  { match: /\bcps\.golf\b/i, platform: "clubprophet" },
  { match: /quick18\.com|sagacitygolf\.com/i, platform: "quick18" },
  { match: /golfback\.com/i, platform: "golfback" },
  { match: /\bteeon\.com/i, platform: "teeon" },
  { match: /ezlinks|teequest/i, platform: "ezlinks" },
  { match: /foretees\.com/i, platform: "foretees" },
];

/** Detect the golf tee-sheet platform from any URL text (page + booking-frame
 *  URLs joined is fine). Returns null when no known platform matches. */
export function detectGolfPlatform(url: string | null | undefined): GolfPlatform | null {
  const u = (url ?? "").toLowerCase();
  if (!u) return null;
  for (const { match, platform } of PLATFORM_HOSTS) {
    if (match.test(u)) return platform;
  }
  return null;
}

/** A tight, platform-specific flow hint appended to the agent's system prompt
 *  so it acts decisively (the right tab, the right rate, the right login
 *  behavior) instead of exploring. Keyed to the researched per-platform flow. */
const HINTS: Record<GolfPlatform, string> = {
  chronogolf:
    'GOLF PLATFORM — CHRONOGOLF / LIGHTSPEED. Ensure the "Visitors" tab is selected (NOT "Members" — Members needs a login you do not have). Then work the accordion top-to-bottom: Date (click the day on the calendar; use the next-month arrow to reach the right month) → "18 holes" (the course is already chosen) → Players (set to the party size) → Tee time (a list of times appears — click the one at/nearest the requested time). Proceed to the guest form and stop at the card step. No login is required for Visitors.',
  foreup:
    'GOLF PLATFORM — FOREUP. Use the PUBLIC reservation path (do not log in). Set the date and number of players, click Search, then click a tee time in the list at/nearest the requested time. Fill the guest details. ForeUp usually allows PAY AT COURSE — if there is NO required credit-card field on the final step, click "Book Time" to COMPLETE the booking (a no-card success — report it confirmed). Only stop at a card step if a card is actually required.',
  teesnap:
    "GOLF PLATFORM — TEESNAP. Set date → holes → players → cart, then RESERVE. TeeSnap REQUIRES an account login to finalize and you do NOT have one — never invent credentials. If it forces a login/registration wall before confirming, report needs_review with reason login_required so the customer can finish; do not loop on the login screen.",
  golfnow:
    "GOLF PLATFORM — GOLFNOW (aggregator). Find the course + the requested date/time in the results, select the tee time, set the players, and proceed to checkout as a GUEST (do not create an account). Fill the guest details and stop at the card step.",
  teeoff:
    "GOLF PLATFORM — TEEOFF (aggregator, same family as GolfNow). Select the course + requested tee time, set players, and check out as a GUEST. Fill the guest details and stop at the card step.",
  "troon-access":
    'GOLF PLATFORM — TROON ACCESS. Set the date + players, Search, click the tee time nearest the requested time, then on the rate step click the plain PUBLIC / STANDARD rate radio (never a membership / "join to save" rate) to enable Continue, and proceed to the guest form. Stop at the card step.',
  clubprophet:
    "GOLF PLATFORM — CLUB PROPHET (cps.golf). Set date + players, search, click the tee time nearest the requested time, pick the standard public rate if asked, fill guest details, and stop at the card step.",
  quick18:
    "GOLF PLATFORM — QUICK18 / SAGACITY. Set the date + players, find the tee-time list, click the slot nearest the requested time, fill guest details, and stop at the card step.",
  golfback:
    "GOLF PLATFORM — GOLFBACK. Set date + players, click the tee time nearest the requested time, fill guest details, and stop at the card step.",
  teeon:
    "GOLF PLATFORM — TEE-ON. Set date + players, click the tee time nearest the requested time, fill guest details, and stop at the card step.",
  ezlinks:
    "GOLF PLATFORM — EZLINKS / TEEQUEST. Set the date + players, Search, click the tee time nearest the requested time (a grid of times), pick the standard public rate if asked, fill guest details, and stop at the card step.",
  foretees:
    "GOLF PLATFORM — FORETEES (private members club). This is members-only and needs a member login you do NOT have. Report needs_review / members_only with any phone number — the public cannot book here.",
};

export function golfPlatformAgentHint(platform: GolfPlatform): string {
  return HINTS[platform];
}
