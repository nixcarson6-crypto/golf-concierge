/**
 * Golf platform-URL resolver.
 *
 * Some big operators BOT-WALL their marketing site while the real tee-time
 * booking lives on a separate, un-walled PLATFORM:
 *   - Troon's troonnorthgolf.com returns a CloudFront 403 to any automation,
 *     but Troon "Access" courses book on golfwithaccess.com (loads fine).
 * Google Places hands us the marketing URL, so the agent gets blocked at the
 * front door and never reaches a booking form. This maps those courses
 * straight to the working booking page.
 *
 * Keyed by a name/website pattern → the platform booking URL. Extend as we
 * confirm more course URLs (give me the golfwithaccess.com/quick18/foreup link
 * and it slots in here).
 */

type PlatformRule = { match: RegExp; url: string };

const GOLF_PLATFORM_URLS: PlatformRule[] = [
  {
    // Troon North — Monument + Pinnacle are both bookable on this one Access
    // page (filter by course on-page). The marketing site (troonnorthgolf.com)
    // is CloudFront-walled; this isn't.
    match: /troon\s*north/i,
    url: "https://www.golfwithaccess.com/course/troon-north-golf-club/reserve-tee-time",
  },
];

/**
 * Returns a platform booking URL to use INSTEAD of the venue's (often
 * bot-walled) marketing website, or null when we have no override and the
 * normal Places website should be used.
 */
export function resolveGolfBookingUrl(args: {
  title: string;
  location: string | null;
  placesWebsite: string | null;
}): string | null {
  const hay = `${args.title} ${args.location ?? ""} ${args.placesWebsite ?? ""}`;
  for (const rule of GOLF_PLATFORM_URLS) {
    if (rule.match.test(hay)) return rule.url;
  }
  return null;
}
