/**
 * Google Places contact lookup (browser-facing route).
 *
 * Thin wrapper over the shared `lookupPlaceContact` lib so the browser
 * dialog can show "Visit website" / "Call" buttons. The agent pipeline
 * imports the lib directly instead of calling this route (avoids the
 * Clerk middleware auth wall on server-to-server calls).
 */

import { NextRequest } from "next/server";
import { lookupPlaceContact } from "@/lib/places/contact";

export async function GET(req: NextRequest) {
  const query = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const loc = (req.nextUrl.searchParams.get("loc") ?? "").trim();
  const contact = await lookupPlaceContact(query, loc);
  return new Response(JSON.stringify(contact), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
