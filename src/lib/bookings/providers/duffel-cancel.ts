/**
 * Duffel order cancellation. Two-step flow:
 *   1. POST /air/order_cancellations          -> creates a pending cancellation,
 *                                                returns the refund quote
 *   2. POST /air/order_cancellations/:id/actions/confirm
 *                                              -> commits it
 *
 * We expose two helpers so the AI can present the refund quote to the
 * customer before committing — important for live (non-sandbox) bookings
 * where the customer needs to know what they'll get back. For sandbox
 * orders the quote is almost always $0 and we just confirm straight away.
 */

import { optionalEnv } from "@/lib/env";

const DUFFEL_BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";

export type CancellationQuote = {
  cancellationId: string;
  orderId: string;
  refundAmount: number; // cents
  refundCurrency: string;
  refundTo: string | null; // "original_form_of_payment" | "voucher" | etc
  expiresAt: string | null;
};

export type CancellationResult =
  | {
      ok: true;
      cancellationId: string;
      orderId: string;
      refundAmount: number; // cents
      refundCurrency: string;
      refundTo: string | null;
      confirmedAt: string | null;
    }
  | { ok: false; error: string };

async function duffelFetch(path: string, init: RequestInit & { apiKey: string }) {
  return fetch(`${DUFFEL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${init.apiKey}`,
      "Duffel-Version": DUFFEL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

/**
 * Step 1: create the cancellation request. Returns the refund quote so
 * the caller can decide whether to confirm.
 */
export async function quoteCancellation(
  orderId: string,
): Promise<{ ok: true; quote: CancellationQuote } | { ok: false; error: string }> {
  const apiKey = optionalEnv("DUFFEL_API_KEY");
  if (!apiKey) return { ok: false, error: "DUFFEL_API_KEY not configured" };

  const res = await duffelFetch("/air/order_cancellations", {
    method: "POST",
    body: JSON.stringify({ data: { order_id: orderId } }),
    apiKey,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Duffel cancellation quote rejected (${res.status}): ${txt.slice(0, 280)}`,
    };
  }
  type QuoteData = {
    id: string;
    order_id: string;
    refund_amount?: string | null;
    refund_currency?: string | null;
    refund_to?: string | null;
    expires_at?: string | null;
  };
  const json = (await res.json()) as { data: QuoteData };
  const d = json.data;
  return {
    ok: true,
    quote: {
      cancellationId: d.id,
      orderId: d.order_id,
      refundAmount: d.refund_amount
        ? Math.round(parseFloat(d.refund_amount) * 100)
        : 0,
      refundCurrency: d.refund_currency ?? "USD",
      refundTo: d.refund_to ?? null,
      expiresAt: d.expires_at ?? null,
    },
  };
}

/**
 * Step 2: confirm the cancellation. Refund is initiated immediately on
 * Duffel's side after this. The quote expires in ~30 minutes — if it
 * does, the caller should re-quote.
 */
export async function confirmCancellation(
  cancellationId: string,
): Promise<CancellationResult> {
  const apiKey = optionalEnv("DUFFEL_API_KEY");
  if (!apiKey) return { ok: false, error: "DUFFEL_API_KEY not configured" };

  const res = await duffelFetch(
    `/air/order_cancellations/${cancellationId}/actions/confirm`,
    { method: "POST", body: JSON.stringify({}), apiKey },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Duffel cancellation confirm rejected (${res.status}): ${txt.slice(0, 280)}`,
    };
  }
  type ConfirmedData = {
    id: string;
    order_id: string;
    refund_amount?: string | null;
    refund_currency?: string | null;
    refund_to?: string | null;
    confirmed_at?: string | null;
  };
  const json = (await res.json()) as { data: ConfirmedData };
  const d = json.data;
  return {
    ok: true,
    cancellationId: d.id,
    orderId: d.order_id,
    refundAmount: d.refund_amount
      ? Math.round(parseFloat(d.refund_amount) * 100)
      : 0,
    refundCurrency: d.refund_currency ?? "USD",
    refundTo: d.refund_to ?? null,
    confirmedAt: d.confirmed_at ?? null,
  };
}

/** One-call helper: quote and immediately confirm. Used by auto-supersede. */
export async function cancelOrder(orderId: string): Promise<CancellationResult> {
  const q = await quoteCancellation(orderId);
  if (!q.ok) return q;
  return confirmCancellation(q.quote.cancellationId);
}
