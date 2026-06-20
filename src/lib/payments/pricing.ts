/**
 * Pyltrix pricing — the concierge service fee charged to the customer on top
 * of the trip cost. ONE source of truth so the agent-path charge
 * (card-provider) and the "Pay" cart checkout never drift.
 *
 * 12% to start (Carson, June 2026). Step to 15–20% once golf is auto-booked
 * (more of the trip handled end-to-end = more service to charge for). Tune it
 * live with env BOOKING_SERVICE_FEE_BPS — e.g. "1500" = 15% — no code change.
 *
 * Note: this is the VISIBLE fee on top of the price. On API-booked hotels you
 * ALSO earn the wholesale spread (retail − net) underneath it; on the agent
 * path (no API) this fee is the whole margin, which is why it has to clear
 * Stripe's ~3% with room to spare.
 */

const DEFAULT_SERVICE_FEE_BPS = 1200; // 12%

/** Current service-fee rate in basis points (100 bps = 1%). */
export function serviceFeeBps(): number {
  const raw = Number(process.env.BOOKING_SERVICE_FEE_BPS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SERVICE_FEE_BPS;
}

/** The service fee, in cents, for a given pre-fee subtotal (in cents). */
export function serviceFeeCents(subtotalCents: number): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  return Math.round((subtotalCents * serviceFeeBps()) / 10_000);
}
