/**
 * Map a destination name to its primary IATA airport code. Used by the
 * build pipeline to pre-fire the home→destination flight search in
 * parallel with the itinerary agent, instead of waiting for the
 * itinerary's FLIGHT items to know which airport to search.
 *
 * Strategy:
 *   1. Curated knowledge base — every market in src/lib/data/
 *      destinations.ts has an `airports[]` list; we extract the IATA
 *      from the first entry.
 *   2. Hardcoded fallback table — covers the popular international
 *      golf destinations and Italian luxury cities (Rome, Como,
 *      Portofino, etc.) that aren't in the curated KB yet. Free,
 *      synchronous, no AI call.
 *   3. Haiku one-shot — final fallback for anything we don't recognise.
 *      Costs ~$0.001 per call and adds ~800ms, still way faster than
 *      waiting on the itinerary agent.
 *
 * Returns null when even Haiku can't produce a valid 3-letter code,
 * in which case the build pipeline falls back to the old behaviour
 * (search slices off the itinerary's FLIGHT items, after they land).
 */

import { findDestination } from "./destinations";
import { anthropic, modelFor } from "@/lib/ai/client";

/**
 * Curated fallback for destinations the KB doesn't cover yet. Maps a
 * lower-cased destination name → primary IATA. Add new entries here
 * when a customer types something we keep missing. Keys are matched
 * with "includes" (case-insensitive) so "Lake Como" hits "como".
 */
const FALLBACKS: Record<string, string> = {
  // Italy
  rome: "FCO",
  roma: "FCO",
  florence: "FLR",
  firenze: "FLR",
  milan: "MXP",
  milano: "MXP",
  como: "MXP",
  "lake como": "MXP",
  portofino: "GOA",
  genoa: "GOA",
  genova: "GOA",
  venice: "VCE",
  venezia: "VCE",
  naples: "NAP",
  napoli: "NAP",
  sicily: "CTA",
  sardinia: "OLB",
  costa: "OLB",
  // UK / Ireland
  london: "LHR",
  edinburgh: "EDI",
  "st andrews": "EDI",
  glasgow: "GLA",
  dublin: "DUB",
  shannon: "SNN",
  // France
  paris: "CDG",
  nice: "NCE",
  cannes: "NCE",
  "saint-tropez": "NCE",
  "st tropez": "NCE",
  // Spain / Portugal
  madrid: "MAD",
  barcelona: "BCN",
  malaga: "AGP",
  marbella: "AGP",
  sotogrande: "AGP",
  lisbon: "LIS",
  algarve: "FAO",
  // Switzerland / Austria / Germany
  zurich: "ZRH",
  geneva: "GVA",
  munich: "MUC",
  vienna: "VIE",
  // Asia
  tokyo: "HND",
  bangkok: "BKK",
  bali: "DPS",
  phuket: "HKT",
  // Caribbean / Mexico
  "cabo san lucas": "SJD",
  cancun: "CUN",
  tulum: "CUN",
  bahamas: "NAS",
  bermuda: "BDA",
  // US extras that aren't yet curated
  pebble: "MRY",
  monterey: "MRY",
  bandon: "OTH",
  pinehurst: "RDU",
  whistling: "MKE",
  streamsong: "TPA",
  "sea island": "BQK",
  pinehurts: "RDU",
};

// Tight IATA regex — exactly three uppercase letters.
const IATA_RE = /^[A-Z]{3}$/;

function fromCuratedKB(destination: string): string | null {
  const kb = findDestination(destination);
  if (!kb || !kb.airports.length) return null;
  // KB entries look like "PHX (Sky Harbor) — 20 min" — pull the IATA
  // off the front.
  const head = kb.airports[0].trim().split(/\s/)[0]?.toUpperCase();
  return head && IATA_RE.test(head) ? head : null;
}

function fromFallbackTable(destination: string): string | null {
  const lower = destination.toLowerCase();
  for (const [key, iata] of Object.entries(FALLBACKS)) {
    if (lower.includes(key)) return iata;
  }
  return null;
}

async function fromHaiku(destination: string): Promise<string | null> {
  try {
    const client = anthropic();
    const res = await client.messages.create({
      model: modelFor("fast"),
      max_tokens: 12,
      system:
        "You return ONE 3-letter IATA airport code for the nearest major international airport to the destination. NO prose, NO punctuation — just the code. Examples: Rome → FCO. Lake Como → MXP. Pebble Beach → MRY.",
      messages: [{ role: "user", content: destination }],
    });
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("")
      .trim()
      .toUpperCase()
      // Defensive — strip any stray period / quote Haiku might add.
      .replace(/[^A-Z]/g, "");
    return IATA_RE.test(text) ? text : null;
  } catch (err) {
    console.warn("[airport-lookup] Haiku fallback failed:", err);
    return null;
  }
}

export async function airportForDestination(
  destination: string,
): Promise<string | null> {
  if (!destination) return null;
  return (
    fromCuratedKB(destination) ??
    fromFallbackTable(destination) ??
    (await fromHaiku(destination))
  );
}
