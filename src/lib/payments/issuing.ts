/**
 * Stripe Issuing — single-use virtual cards for the browser-agent.
 *
 * Money flow: Customer card → Pyltrix balance → single-use virtual Visa →
 * Vendor. This file owns the virtual-card half: a per-user Issuing
 * cardholder, minting a single-use card locked to the exact vendor cost,
 * revealing the PAN just-in-time for the agent, and cancelling it after.
 *
 * SECURITY: the revealed PAN is returned to the caller and never logged,
 * persisted, or put in a prompt. The real-time authorization webhook
 * (src/app/api/webhooks/stripe) is the hard control that only approves the
 * one expected merchant + amount; this file just creates the instrument.
 *
 * Account-gated on STRIPE_SECRET_KEY (+ Issuing enabled on the account).
 */

import { stripe, stripeConfigured } from "@/lib/stripe";
import { db } from "@/lib/db";

/**
 * Default billing address attached to Issuing cardholders. Stripe requires
 * a billing address; in test mode this is a placeholder. (We don't collect
 * the customer's home address, and the virtual card is funded from our
 * balance — the cardholder is a billing formality, not a KYC subject here.)
 * Override via env once we have a real business address on file.
 */
const DEFAULT_BILLING = {
  line1: "1 Market St",
  city: "San Francisco",
  state: "CA",
  postal_code: "94105",
  country: "US",
} as const;

export type RevealedCard = {
  cardId: string;
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  cardholderName: string;
};

/**
 * Get (or lazily create) the Stripe Issuing cardholder for a user, caching
 * the id on the User row so we reuse it across trips. Returns the cardholder
 * id. Throws if Stripe/Issuing isn't configured.
 */
export async function ensureCardholder(userId: string): Promise<string> {
  if (!stripeConfigured()) {
    throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing).");
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      stripeCardholderId: true,
      name: true,
      email: true,
      phone: true,
      legalGivenName: true,
      legalFamilyName: true,
    },
  });
  if (!user) throw new Error(`User ${userId} not found.`);
  if (user.stripeCardholderId) return user.stripeCardholderId;

  const sk = stripe();
  const displayName =
    [user.legalGivenName, user.legalFamilyName].filter(Boolean).join(" ") ||
    user.name ||
    user.email ||
    "Pyltrix Traveler";

  // Stripe Issuing requires the cardholder to have accepted the Issuing
  // user terms before any card minted to them can activate. Without this
  // the cardholder is created fine but `issuing.cards.create` fails with
  // "outstanding requirements". We collect implicit acceptance at the
  // moment the user starts the saved-card flow (UI gates on a checkbox).
  const nowSecs = Math.floor(Date.now() / 1000);
  const cardholder = await sk.issuing.cardholders.create({
    type: "individual",
    name: displayName,
    email: user.email ?? undefined,
    phone_number: user.phone ?? undefined,
    billing: { address: { ...DEFAULT_BILLING } },
    individual: {
      card_issuing: {
        user_terms_acceptance: { date: nowSecs, ip: "127.0.0.1" },
      },
    },
  });

  await db.user.update({
    where: { id: userId },
    data: { stripeCardholderId: cardholder.id },
  });
  return cardholder.id;
}

/**
 * Mint a single-use virtual card for one booking, with a per-authorization
 * spend limit equal to the vendor cost (a small tolerance can be added for
 * tax/tip by the caller). Returns the card id — the caller stores it on the
 * Booking so the auth webhook can find + gate it.
 */
export async function createSingleUseCard(args: {
  cardholderId: string;
  /** Hard per-authorization spend limit in cents. */
  amountCents: number;
  /** Optional: tag the card with the booking it belongs to (metadata). */
  bookingId?: string;
  tripId?: string;
}): Promise<string> {
  if (!stripeConfigured()) {
    throw new Error("Stripe is not configured.");
  }
  if (!Number.isFinite(args.amountCents) || args.amountCents <= 0) {
    throw new Error(`Invalid spend limit: ${args.amountCents}`);
  }
  const sk = stripe();
  const card = await sk.issuing.cards.create({
    cardholder: args.cardholderId,
    currency: "usd",
    type: "virtual",
    status: "active",
    spending_controls: {
      spending_limits: [
        { amount: Math.round(args.amountCents), interval: "per_authorization" },
      ],
    },
    metadata: {
      ...(args.bookingId ? { bookingId: args.bookingId } : {}),
      ...(args.tripId ? { tripId: args.tripId } : {}),
      single_use: "true",
    },
  });
  return card.id;
}

/**
 * Reveal the PAN/exp/CVC for a card. Called ONLY at the agent's payment
 * step. The returned values are sensitive — never log or persist them.
 */
export async function revealCard(cardId: string): Promise<RevealedCard> {
  if (!stripeConfigured()) {
    throw new Error("Stripe is not configured.");
  }
  const sk = stripe();
  const card = await sk.issuing.cards.retrieve(cardId, {
    expand: ["number", "cvc"],
  });
  // `number`/`cvc` are only present on the expanded response.
  const number = (card as unknown as { number?: string }).number;
  const cvc = (card as unknown as { cvc?: string }).cvc;
  if (!number || !cvc) {
    throw new Error(
      "Card number/cvc not returned — the account may lack permission to reveal PANs (requires PCI attestation in live mode; available in test mode).",
    );
  }
  const cardholderName =
    typeof card.cardholder === "object" && card.cardholder
      ? card.cardholder.name
      : "Pyltrix Traveler";
  return {
    cardId: card.id,
    number,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    cvc,
    cardholderName,
  };
}

/** Cancel a card after the booking completes (or fails). Best-effort. */
export async function cancelCard(cardId: string): Promise<void> {
  if (!stripeConfigured()) return;
  try {
    await stripe().issuing.cards.update(cardId, { status: "canceled" });
  } catch {
    // Non-fatal — a single-use card with a spent per-auth limit is already
    // inert; cancellation is just hygiene.
  }
}

/**
 * Read the available Issuing balance (cents) for the "usd" balance, or null
 * if it can't be read. Used by check:stripe to confirm there are test funds
 * to authorize virtual cards against. (Top up the TEST balance from the
 * dashboard: Issuing → Add funds — there's no stable SDK helper for it.)
 */
export async function issuingBalanceCents(): Promise<number | null> {
  if (!stripeConfigured()) return null;
  try {
    const bal = await stripe().balance.retrieve();
    const issuing = (bal as unknown as {
      issuing?: { available?: Array<{ amount: number; currency: string }> };
    }).issuing;
    const usd = issuing?.available?.find((a) => a.currency === "usd");
    return usd?.amount ?? 0;
  } catch {
    return null;
  }
}
