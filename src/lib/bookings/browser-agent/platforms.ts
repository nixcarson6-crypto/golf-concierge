/**
 * Reservation-platform detection.
 *
 * Carson's call: OpenTable + Resy restaurants get a one-tap CLICKOUT
 * (deep link to their reservation page) — we do NOT bot-automate them,
 * because both ban automation in their ToS and run bot detection that
 * could get our Browserbase IPs / Stripe virtual cards flagged. ANY
 * restaurant with its OWN independent website gets fully auto-booked by
 * the agent as normal.
 *
 * Two detection points use this:
 *   1. Up front in run-booking — if the venue's resolved website IS an
 *      OpenTable/Resy URL, skip the agent entirely and clickout.
 *   2. Mid-run via the agent prompt — if the agent navigates an
 *      independent site that redirects into OpenTable/Resy, it stops and
 *      reports the URL, which we turn into the same clickout.
 */

export type ReservationPlatform = "opentable" | "resy";

/** Classify a URL. Returns the banned-for-automation platform, or null
 *  for an independent site the agent should book normally. */
export function detectReservationPlatform(
  url: string | null | undefined,
): ReservationPlatform | null {
  if (!url) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not a parseable URL — treat the raw string as a haystack.
    host = url.toLowerCase();
  }
  if (host.includes("opentable.")) return "opentable";
  if (host.includes("resy.com")) return "resy";
  return null;
}

export function platformLabel(p: ReservationPlatform): string {
  return p === "opentable" ? "OpenTable" : "Resy";
}
