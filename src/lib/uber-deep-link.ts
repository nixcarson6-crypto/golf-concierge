/**
 * Uber Universal Links — opens the Uber app (or web view) with a ride
 * pre-filled. No API key, no approval, no auth wall — works on iOS,
 * Android, and desktop browsers as a fallback.
 *
 * We use this for MVP ground-transport "booking": the customer taps
 * "Ride with Uber" on a TRANSPORT item, Uber takes the dropoff details,
 * and they confirm + pay through Uber directly.  Once our Central API
 * access is approved we can swap this for true in-app Uber booking; the
 * call site stays the same.
 *
 * Reference: https://developer.uber.com/docs/riders/ride-requests/tutorials/deep-links/introduction
 */

export type UberDeepLinkArgs = {
  /** Human-readable name of the destination — appears in Uber's UI. */
  dropoffName?: string | null;
  /** Full street address of the destination. Required for the link to
   *  resolve to an actual location. */
  dropoffAddress?: string | null;
  /** Optional lat/lng. When provided, the dropoff is pinned exactly
   *  rather than relying on Uber's geocoder. */
  dropoffLat?: number | null;
  dropoffLng?: number | null;
};

/**
 * Build an Uber Universal Link URL for the given dropoff. Returns null
 * when there isn't enough info to resolve a destination — callers should
 * hide the CTA in that case rather than open a broken Uber screen.
 *
 * On mobile this opens the Uber app if installed; otherwise it falls
 * back to m.uber.com.  Pickup defaults to the user's current location
 * via `pickup=my_location` so we don't have to know where the customer
 * is when we render the itinerary.
 */
export function buildUberDeepLink(args: UberDeepLinkArgs): string | null {
  const name = (args.dropoffName ?? "").trim();
  const address = (args.dropoffAddress ?? "").trim();
  const hasCoords =
    typeof args.dropoffLat === "number" &&
    typeof args.dropoffLng === "number" &&
    !Number.isNaN(args.dropoffLat) &&
    !Number.isNaN(args.dropoffLng);

  if (!address && !name && !hasCoords) return null;

  const params = new URLSearchParams();
  params.set("action", "setPickup");
  params.set("pickup", "my_location");
  if (name) params.set("dropoff[nickname]", name);
  if (address) params.set("dropoff[formatted_address]", address);
  if (hasCoords) {
    params.set("dropoff[latitude]", String(args.dropoffLat));
    params.set("dropoff[longitude]", String(args.dropoffLng));
  }
  return `https://m.uber.com/ul/?${params.toString()}`;
}
