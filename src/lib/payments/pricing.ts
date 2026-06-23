/**
 * Pyltrix pricing — the concierge service fee charged to the customer on top
 * of the trip cost. ONE source of truth so every charge path (the agent-path
 * card-provider, the "Pay" cart checkout, flight payment) and the customer-
 * facing totals never drift.
 *
 * Carson's pricing (June 2026):
 *   - 10% standard.
 *   - 8% on big trips (vendor cost ≥ $25,000) — a flat 10% on a $40k trip
 *     produces a fee that *feels* gougy even though it's fair; tapering fixes it.
 *   - $250 floor — on a sub-$2,500 trip, 10% wouldn't cover a Browserbase
 *     session + AI + support. (Only binds below ~$2,500; luxury trips never hit
 *     it.) The floor is a TRIP-LEVEL display minimum — NOT applied per-item, or
 *     it would over-charge a single $300 golf round.
 *   - Shown TRANSPARENTLY as a line on top of real prices — never a hidden
 *     markup baked into the rate (luxury customers price-check; a secret markup
 *     reads as a scam, a visible fee reads as a premium service).
 *
 * Tune the STANDARD rate live with env BOOKING_SERVICE_FEE_BPS — e.g. "1500" =
 * 15% — no code change. The 8% taper still caps big trips below that.
 *
 * Note: this is the VISIBLE fee. We ALSO earn the wholesale spread baked into
 * the bedbank/Duffel rates underneath it — that's invisible and NOT added here
 * (stacking it on the visible fee is where it would start to feel dishonest).
 */

const DEFAULT_STANDARD_BPS = 1000; // 10%
const LARGE_TRIP_BPS = 800; // 8% on big trips
/** Trips with vendor cost at/above this use the lower (8%) rate. $25,000. */
const LARGE_TRIP_THRESHOLD_CENTS = 25_000_00;
/** Trip-level minimum fee so a tiny trip still covers its cost. $250. */
const FEE_FLOOR_CENTS = 250_00;

/**
 * Service-fee rate in basis points for a given subtotal. The STANDARD rate is
 * env-overridable; big trips taper to 8% (never above it). Call with no arg for
 * the bare standard rate.
 */
export function serviceFeeBps(subtotalCents = 0): number {
  const envRaw = Number(process.env.BOOKING_SERVICE_FEE_BPS);
  const standard =
    Number.isFinite(envRaw) && envRaw >= 0 ? envRaw : DEFAULT_STANDARD_BPS;
  return subtotalCents >= LARGE_TRIP_THRESHOLD_CENTS
    ? Math.min(standard, LARGE_TRIP_BPS)
    : standard;
}

/** The fee RATE (fraction) for a given vendor cost — for "10%"/"8%" labels. */
export function conciergeFeeRate(vendorCents: number): number {
  return serviceFeeBps(vendorCents) / 10_000;
}

/**
 * The service fee, in cents, for a given pre-fee subtotal. Applies the (tapered)
 * rate. NO floor — this is the per-charge fee; the $250 floor is a trip-level
 * display minimum (see tripTotals), so it can't over-charge a small item.
 */
export function serviceFeeCents(subtotalCents: number): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  return Math.round((subtotalCents * serviceFeeBps(subtotalCents)) / 10_000);
}

export type TripTotals = {
  /** Real cost of the bookings (what the vendors get). */
  vendorCents: number;
  /** Pyltrix concierge fee (with the trip-level floor applied). */
  feeCents: number;
  /** What the customer pays = vendor + fee. */
  totalCents: number;
  /** The rate applied (0.10 / 0.08) for the label — null when the floor
   *  overrode the percentage, so the UI just shows the dollar fee. */
  feeRate: number | null;
};

/** Full breakdown for the customer-facing totals (rate + $250 trip floor). */
export function tripTotals(vendorCents: number): TripTotals {
  const v = Math.max(0, Math.round(vendorCents || 0));
  const pct = serviceFeeCents(v);
  const feeCents = v > 0 ? Math.max(pct, FEE_FLOOR_CENTS) : 0;
  return {
    vendorCents: v,
    feeCents,
    totalCents: v + feeCents,
    feeRate: feeCents > pct ? null : conciergeFeeRate(v),
  };
}
