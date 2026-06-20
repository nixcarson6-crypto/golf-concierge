/**
 * Single source of truth for WHAT the browser agent books.
 *
 * The agent handles the high-value reservations that have a real web
 * booking flow: HOTELS and CAR RENTALS. Flights go through Duffel.
 *
 * GOLF (tee times) is SELF-BOOK at launch (June 2026): there's no reliable
 * tee-time API, the browser agent can't be trusted with the exact date/time,
 * and customers WANT to choose their round + time with their group anyway —
 * so we hand them a direct booking link and they reserve it themselves.
 * Re-enable the golf agent once it's reliable with
 * NEXT_PUBLIC_GOLF_AGENT_ENABLED=true.
 *
 * Dining / activities / nightlife / spa are presented as contact suggestions
 * (call/website), never auto-booked.
 *
 * TRANSPORT is special: a trip's transport items are mostly per-ride
 * Uber/chauffeur transfers ("Uber Black: AUS → Omni Barton Creek") that
 * you summon in-app day-of — there's no website form to fill. Only a
 * CAR RENTAL ("Luxury SUV rental", "Hertz …") has a bookable site. So we
 * only route the agent at transport items that look like a rental/hire.
 *
 * Pure + dependency-free so both the client panel and the server route
 * import the exact same logic (no drift between what the UI offers and
 * what the endpoint accepts).
 */

/** Item types the agent can book outright (no per-item inspection). Golf
 *  (TEE_TIME) used to live here but is now SELF-BOOK by default — see below. */
const ALWAYS_BOOKABLE = new Set(["LODGING"]);

/**
 * KILL SWITCH (MVP): item types forced to "links only" — the agent never
 * attempts them; they stay recommendations with their Visit-website / Call
 * links. Set NEXT_PUBLIC_BOOKING_LINKS_ONLY to a comma list, e.g.
 *   "TEE_TIME"          → golf becomes links (no API exists for golf anyway)
 *   "TEE_TIME,LODGING"  → golf + hotels both links
 *   "ALL"               → everything links
 * NEXT_PUBLIC_ so the client panel and the server route read the SAME value
 * (the button hides AND the endpoint skips — no drift). Empty = agent on.
 * NOTE: for HOTELS, prefer HOTEL_AGENT_DISABLED (run-booking) instead — that
 * still lets LiteAPI/Hotelbeds book covered hotels and only links the misses.
 */
function linksOnlyTypes(): Set<string> {
  const raw = process.env.NEXT_PUBLIC_BOOKING_LINKS_ONLY ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * True when the agent should book this item. Hotels + golf always; a
 * transport item only when it's a car rental (not an Uber/chauffeur ride).
 */
export function isAgentBookable(
  type: string,
  title?: string | null,
  description?: string | null,
): boolean {
  const off = linksOnlyTypes();
  if (off.has("ALL") || off.has(type)) return false;
  // GOLF is self-book by default (launch decision) — the customer reserves
  // their own tee time so they can pick the round + time with their group,
  // and we never risk auto-booking the wrong slot. Opt back in per-env.
  if (type === "TEE_TIME") return golfAgentEnabled();
  if (ALWAYS_BOOKABLE.has(type)) return true;
  if (type === "TRANSPORT") return isCarRental(title, description);
  return false;
}

/** Opt-in re-enable of the browser agent for golf — OFF by default at launch.
 *  Flip NEXT_PUBLIC_GOLF_AGENT_ENABLED=true once the agent is reliable enough
 *  to trust with the exact tee date/time. */
function golfAgentEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_GOLF_AGENT_ENABLED ?? "").trim().toLowerCase() ===
    "true"
  );
}

/**
 * Heuristic: is this transport item a CAR RENTAL (bookable on a rental
 * site) vs. a point-to-point ride (Uber/Blacklane/private driver)?
 *
 * Negative signals win — an item that mentions Uber / a chauffeur / a
 * route arrow is a ride, never a rental, even if the word "car" appears.
 */
export function isCarRental(
  title?: string | null,
  description?: string | null,
): boolean {
  const hay = `${title ?? ""} ${description ?? ""}`.toLowerCase();
  // Per-ride transfers — NOT a rental. Route arrows, ride-hail brands,
  // and chauffeur language all mean "summon a ride", not "rent a car".
  if (
    /\buber\b|\blyft\b|\bblacklane\b|chauffeur|private\s+driver|car\s+service|→|->|\btransfer\b|pick[\s-]?up/.test(
      hay,
    )
  ) {
    return false;
  }
  // Positive rental signals: the word "rental"/"hire", or a known
  // rental-car brand.
  return /\brental\b|\brent[\s-]?a[\s-]?car\b|\bcar\s+hire\b|\bhire\s+car\b|\bhertz\b|\benterprise\b|\bavis\b|\bsixt\b|\beuropcar\b|\bnational\s+car\b|\balamo\b|\bbudget\s+rent/.test(
    hay,
  );
}
