/**
 * The full state machine that turns a queued booking request into a real
 * booking. Called from the `onBookingAgentRequested` Inngest function so it
 * can run for the 5-10 minutes the agent loop needs without colliding with
 * Vercel's request timeout.
 *
 * Responsibilities, in order:
 *   1. Load the booking + item + traveller + venue (one query batch).
 *   2. Idempotency: if the booking is already CONFIRMED, no-op + return.
 *   3. Resolve the venue URL via the existing Google Places contact lookup,
 *      falling back to `item.location` if Places has nothing.
 *   4. Wrap everything in `withAgentRun` so progress streams to the DB
 *      AND to the SSE bus (via the internal nudge bridge — see §nudge).
 *   5. Open a Browserbase session, navigate to the URL, run the agent
 *      loop with a Stripe-Issuing-backed CardProvider.
 *   6. Run the agent outcome through the skeptical brain (`verifyOutcome`).
 *   7. Persist: update Booking status / confirmation / screenshot,
 *      ItineraryItem.confirmationState, audit, final nudge.
 *
 * Never throws inside the agent loop — every failure produces a verified
 * outcome that we record (FAILED / NEEDS_REVIEW) so the UI can show an
 * honest state instead of bouncing the user to an error page.
 */

import { db } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { audit } from "@/lib/audit";
import { withAgentRun } from "@/lib/ai/orchestrator";
import { withSession, navigate } from "./runtime";
import { runAgent } from "./agent";
import { buildGoal } from "./goal";
import { buildBookingTask } from "./types";
import {
  verifyOutcome,
  toBookingStatus,
  toConfirmationState,
  type RawBookingOutcome,
} from "./outcome";
import { buildCardProviderForBooking } from "./card-provider";
import type { BookingRequest } from "../types";

export async function runBrowserBooking(args: {
  tripId: string;
  bookingId: string;
  itineraryItemId: string;
  userId: string;
}): Promise<void> {
  // ---------------------------------------------------------------------- 1
  // Load everything in one parallel batch so we don't ping the DB pool
  // four separate times before the agent even starts.
  const [booking, item, user, places] = await Promise.all([
    db.booking.findUnique({ where: { id: args.bookingId } }),
    db.itineraryItem.findUnique({
      where: { id: args.itineraryItemId },
      include: { itinerary: { select: { tripId: true } } },
    }),
    db.user.findUnique({
      where: { id: args.userId },
      select: {
        email: true,
        legalGivenName: true,
        legalFamilyName: true,
        phone: true,
        dateOfBirth: true,
      },
    }),
    // Lazy import keeps the Google Places client out of the cold path on
    // setups where the key isn't configured.
    resolveVenueContact({ tripId: args.tripId, itineraryItemId: args.itineraryItemId }),
  ]);

  if (!booking || !item || !user) {
    console.warn(
      `[browser-booking] missing rows — booking:${Boolean(booking)} item:${Boolean(item)} user:${Boolean(user)}`,
    );
    return;
  }

  // ---------------------------------------------------------------------- 2
  // Idempotency. Inngest retries call this again on failure; we must NOT
  // re-book a confirmed reservation. If the booking is past the agent loop
  // (CONFIRMED / FAILED / CANCELLED / NEEDS_REVIEW), no-op.
  if (
    booking.status === "CONFIRMED" ||
    booking.status === "FAILED" ||
    booking.status === "CANCELLED" ||
    booking.status === "NEEDS_REVIEW"
  ) {
    console.info(
      `[browser-booking] booking ${args.bookingId} is already ${booking.status} — skipping retry.`,
    );
    return;
  }

  // ---------------------------------------------------------------------- 3
  // Build the agent's marching orders.
  const startUrl = places.website ?? (item.location ?? "").trim();
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    // No website to book against. Mark FAILED with the "no online form"
    // failure code so the UI shows the website/phone fallback honestly.
    await markBookingFailed({
      booking,
      itemId: item.id,
      tripId: args.tripId,
      failureReason: "form_not_found",
      message: "We couldn't find an online booking page for this venue.",
      fallbackContact: { website: null, phone: places.phone ?? null },
    });
    return;
  }

  // (No platform short-circuit. The agent tries every venue, including
  // OpenTable/Resy. The customer authorised us to book a reservation —
  // we're filling in the same form a human would. If a captcha/login
  // wall blocks the agent, the existing failure path shows a "Visit
  // website" fallback button, which is functionally identical to a
  // clickout. So we get full automation when it works and the same
  // graceful fallback when it doesn't.)

  const traveler = {
    givenName: user.legalGivenName?.trim() || "",
    familyName: user.legalFamilyName?.trim() || "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    dateOfBirth: user.dateOfBirth
      ? user.dateOfBirth.toISOString().slice(0, 10)
      : null,
    partySize:
      (item.metadata as { partySize?: number } | null)?.partySize ?? 1,
  };

  if (!traveler.givenName || !traveler.familyName || !traveler.email) {
    await markBookingFailed({
      booking,
      itemId: item.id,
      tripId: args.tripId,
      failureReason: "ambiguous",
      message:
        "Your traveller profile is missing a name or email — fill it in, then we'll take another shot.",
      fallbackContact: { website: startUrl, phone: places.phone ?? null },
    });
    return;
  }

  const request: BookingRequest = {
    tripId: args.tripId,
    itineraryItemId: item.id,
    type: item.type,
    title: item.title,
    startTime: item.startTime,
    endTime: item.endTime,
    party: traveler.partySize,
    budget: item.cost,
    location: item.location,
    metadata: (item.metadata as Record<string, unknown> | null) ?? {},
  };

  const venue = {
    name: item.title,
    startUrl,
    address: item.address ?? item.location ?? null,
    phone: places.phone ?? null,
  };
  const task = buildBookingTask({ request, traveler, venue });
  const goal = buildGoal(task);

  const cardProvider = buildCardProviderForBooking({
    userId: args.userId,
    bookingId: args.bookingId,
    tripId: args.tripId,
    budgetCents: task.budgetCents,
  });

  // ---------------------------------------------------------------------- 4
  // The agent run itself, wrapped in withAgentRun so progress lands in the
  // AgentRun row AND streams over SSE via the nudge bridge.
  await withAgentRun({
    tripId: args.tripId,
    agentType: "BROWSER_BOOKING",
    progress: "Queued — opening venue site…",
    input: { bookingId: args.bookingId, itineraryItemId: item.id, venue: venue.name },
    fn: async ({ runId, updateProgress }) => {
      // Link the AgentRun + the Booking so the UI can join them.
      await db.booking.update({
        where: { id: booking.id },
        data: { agentRunId: runId, vendorUrl: startUrl },
      });

      const bridgeNudge = async (label: string) => {
        await updateProgress(label);
        try {
          await postInternalNudge({ tripId: args.tripId, runId, progress: label });
        } catch {
          /* nudge failures must never block the booking */
        }
      };

      // Seed with a failed default so TS knows `outcome` is always set
      // even before the first attempt runs; the loop overwrites it.
      let outcome: RawBookingOutcome = {
        status: "failed",
        failureReason: "ambiguous",
        message: "Agent did not run.",
      };
      let finalScreenshot: string | null = null;

      // Engine selection. DEFAULT is Stagehand (DOM-driven) — ~2x faster
      // and ~11pts more reliable than the legacy vision loop per 2026
      // benchmarks. The zod-v4 migration that Stagehand needs has landed
      // (orchestrator now uses z.toJSONSchema; all 49 brain tests + full
      // typecheck pass on v4). Set BOOKING_ENGINE=computer-use to fall
      // back to the old screenshot agent if ever needed.
      const engine =
        (optionalEnv("BOOKING_ENGINE") ?? "stagehand").toLowerCase();
      const useStagehand = engine !== "computer-use";
      const captchaOn =
        optionalEnv("BROWSERBASE_PREMIUM") === "true" ||
        optionalEnv("BROWSERBASE_SOLVE_CAPTCHAS") === "true";
      const stealthOn =
        optionalEnv("BROWSERBASE_PREMIUM") === "true" ||
        optionalEnv("BROWSERBASE_ADVANCED_STEALTH") === "true";

      // One agent attempt against a FRESH Browserbase session. A fresh
      // session means a fresh residential IP + clean fingerprint, which
      // is exactly what flips a captcha/bot-wall failure into a success
      // on the next try.
      const attemptOnce = async () => {
        try {
          if (useStagehand) {
            const { runStagehandBooking } = await import("./stagehand-runner");
            // Per-type step budget. Hotels run the longest flow
            // (date→search→room→rate→guest-details) and blew past the old
            // flat 35-step cap; car rentals are medium (location→dates→
            // vehicle→driver); golf is short. Sizing each keeps the quick
            // ones FAST while giving the long ones room to finish.
            const maxSteps =
              item.type === "LODGING"
                ? 55
                : item.type === "TRANSPORT"
                  ? 45
                  : 35;
            const result = await runStagehandBooking({
              startUrl,
              system: goal.system,
              task: goal.firstUserMessage,
              solveCaptchas: captchaOn,
              advancedStealth: stealthOn,
              timeoutMs: 600_000,
              maxSteps,
              // Just-in-time payment: when the agent reaches the card step,
              // this charges the customer + mints a single-use virtual card
              // and the runner types it in. Returns `unavailable` (→ clean
              // needs_review, no card entered) when Stripe isn't configured
              // or the customer hasn't saved a card.
              cardProvider,
              onStep: async (label) => {
                await bridgeNudge(label);
              },
            });
            return { outcome: result.outcome, finalScreenshot: null };
          }
          const result = await withSession(async (session) => {
            await bridgeNudge(`Opening ${shortHost(startUrl)}…`);
            await navigate(session.page, startUrl);
            await sleep(2500);
            return await runAgent({
              page: session.page,
              system: goal.system,
              firstUserMessage: goal.firstUserMessage,
              cardProvider,
              onStep: async ({ label }) => {
                await bridgeNudge(label);
              },
            });
          });
          return {
            outcome: result.outcome,
            finalScreenshot: result.finalScreenshot,
          };
        } catch (err) {
          return {
            outcome: {
              status: "failed" as const,
              failureReason: "ambiguous" as const,
              message: err instanceof Error ? err.message : String(err),
            },
            finalScreenshot: null as string | null,
          };
        }
      };

      // Retry ONLY the failures a fresh session can fix — captcha walls,
      // bot-detection, timeouts, ambiguous runtime crashes. Captcha
      // solving is ~88-95% per attempt, so 2-3 tries compounds to ~99%.
      // NEVER retry: a real card decline, genuine no-availability,
      // over-budget, or a login wall — those won't change on a retry,
      // and a CONFIRMED result obviously stops immediately. The single-
      // use virtual card + the 2s auth webhook guarantee at most one
      // charge even if a retry somehow re-reached checkout, so retrying
      // is safe.
      const RETRYABLE = new Set(["captcha_blocked", "timeout", "ambiguous"]);
      const MAX_ATTEMPTS = Number(optionalEnv("BROWSER_AGENT_MAX_ATTEMPTS")) || 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          await bridgeNudge(
            `Hit a verification wall — trying again (${attempt}/${MAX_ATTEMPTS})…`,
          );
          await sleep(1500);
        }
        const r = await attemptOnce();
        outcome = r.outcome;
        finalScreenshot = r.finalScreenshot;
        const reason =
          outcome.status === "failed"
            ? (outcome as { failureReason?: string }).failureReason
            : undefined;
        const shouldRetry =
          outcome.status === "failed" &&
          reason != null &&
          RETRYABLE.has(reason) &&
          attempt < MAX_ATTEMPTS;
        if (!shouldRetry) break;
      }


      // -------------------------------------------------------------- 5/6
      // Brain gate: refuse to confirm without hard evidence. Downgrades
      // unproven success / contradictions / over-budget to NEEDS_REVIEW.
      const verified = verifyOutcome(outcome, {
        budgetCents: task.budgetCents,
        venueName: venue.name,
      });

      // ---------------------------------------------------------------- 7
      // Persist. Screenshot stored as a data URL on the Booking row — the
      // v1 "no blob-storage infra needed" path from CLAUDE.md.
      const screenshotDataUrl = finalScreenshot
        ? `data:image/png;base64,${finalScreenshot}`
        : null;

      const existingMeta =
        (booking.metadata as Record<string, unknown> | null) ?? {};
      // For phone/email-only venues the agent writes the venue's contact
      // details into its message (per the prompt). Google Places gives us
      // a phone but never an email, so we mine the agent's message for the
      // email (and a phone as a backstop). The customer then gets a
      // one-tap Call button AND a pre-drafted reservation email.
      const mined = extractContacts(outcome.message ?? "");
      const nextMeta: Record<string, unknown> = {
        ...existingMeta,
        vendorConfirmation: verified.evidence ?? null,
        failureReason: verified.failureCode ?? null,
        fallbackContact: {
          website: places.website ?? startUrl,
          phone: places.phone ?? mined.phone ?? null,
          email: mined.email ?? null,
        },
        amountChargedCents: verified.amountChargedCents ?? null,
        agentMessage: outcome.message ?? null,
      };

      await db.booking.update({
        where: { id: booking.id },
        data: {
          status: toBookingStatus(verified),
          confirmationCode: verified.confirmationCode,
          confirmedAt: verified.status === "CONFIRMED" ? new Date() : null,
          screenshotUrl: screenshotDataUrl,
          lastError:
            verified.status === "FAILED"
              ? outcome.message?.slice(0, 1000) ?? null
              : null,
          metadata: nextMeta as object,
          attempts: { increment: 1 },
        },
      });

      await db.itineraryItem.update({
        where: { id: item.id },
        data: {
          confirmationState: toConfirmationState(verified),
          status:
            verified.status === "CONFIRMED"
              ? `Booked${verified.confirmationCode ? ` · ${verified.confirmationCode}` : ""}`
              : verified.status === "FAILED"
                ? "Couldn't book — see fallback"
                : "Pyltrix concierge reviewing…",
        },
      });

      await audit({
        tripId: args.tripId,
        action:
          verified.status === "CONFIRMED"
            ? "BOOKING_CONFIRMED"
            : "BOOKING_FAILED",
        title:
          verified.status === "CONFIRMED"
            ? `Booked ${item.title}`
            : `Couldn't auto-book ${item.title}`,
        detail: verified.customerMessage.slice(0, 500),
        actorKind: "agent",
        actorId: "browser-agent",
        metadata: {
          bookingId: booking.id,
          itineraryItemId: item.id,
          status: verified.status,
        },
      });

      // Final SSE refetch so the dialog flips immediately.
      try {
        await postInternalNudge({ tripId: args.tripId });
      } catch {}

      return {
        status: verified.status,
        confirmationCode: verified.confirmationCode,
        failureCode: verified.failureCode,
      };
    },
  }).catch((err) => {
    // The orchestrator wrapper itself blew up (DB write etc.). Mark the
    // booking FAILED so we don't strand it in SEARCHING.
    void db.booking
      .update({
        where: { id: booking.id },
        data: {
          status: "FAILED",
          lastError: err instanceof Error ? err.message : String(err),
        },
      })
      .catch(() => {});
    void db.itineraryItem
      .update({
        where: { id: item.id },
        data: { confirmationState: "FAILED", status: "Booking failed" },
      })
      .catch(() => {});
    console.error("[browser-booking] withAgentRun threw", err);
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Resolve the venue's website + phone via the shared Places lookup.
 *  Calls the lib DIRECTLY (not the HTTP route) — the route is behind
 *  Clerk middleware and this runs server-side with no session, so an
 *  HTTP call would 404 and the agent would never find a website to
 *  book against. */
async function resolveVenueContact(args: {
  tripId: string;
  itineraryItemId: string;
}): Promise<{ website: string | null; phone: string | null }> {
  const item = await db.itineraryItem.findUnique({
    where: { id: args.itineraryItemId },
    select: { title: true, location: true },
  });
  if (!item?.title) return { website: null, phone: null };

  // Clean the venue name for the Places search. Itinerary titles carry
  // a meal/activity prefix ("Dinner — Sunset Monalisa", "Lunch at X",
  // "Round at Valhalla") that pollutes the search — strip it so we look
  // up the actual venue name.
  const venueName = item.title
    .replace(/^(dinner|lunch|breakfast|brunch|drinks|cocktails|round|tee\s*time|spa|massage)\s*(—|–|-|:|at)\s*/i, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim() || item.title;

  const { lookupPlaceContact } = await import("@/lib/places/contact");
  const contact = await lookupPlaceContact(venueName, item.location ?? undefined);
  return { website: contact.website, phone: contact.phone };
}

async function postInternalNudge(args: {
  tripId: string;
  runId?: string;
  progress?: string;
}): Promise<void> {
  const secret = optionalEnv("INTERNAL_NUDGE_SECRET");
  if (!secret) return;
  const appUrl = optionalEnv("NEXT_PUBLIC_APP_URL") ?? "http://localhost:3000";
  await fetch(`${appUrl}/api/internal/nudge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify(args),
  });
}

async function markBookingFailed(args: {
  booking: { id: string; metadata: unknown };
  itemId: string;
  tripId: string;
  failureReason: string;
  message: string;
  fallbackContact: { website: string | null; phone: string | null };
}): Promise<void> {
  const existing =
    (args.booking.metadata as Record<string, unknown> | null) ?? {};
  await db.booking.update({
    where: { id: args.booking.id },
    data: {
      status: "FAILED",
      lastError: args.message,
      metadata: {
        ...existing,
        failureReason: args.failureReason,
        fallbackContact: args.fallbackContact,
      } as object,
      attempts: { increment: 1 },
    },
  });
  await db.itineraryItem.update({
    where: { id: args.itemId },
    data: { confirmationState: "FAILED", status: "Couldn't book — see fallback" },
  });
  try {
    await postInternalNudge({ tripId: args.tripId });
  } catch {}
}


/**
 * Mine an email + phone out of the agent's free-text outcome message.
 * Used for phone/email-only venues where the agent reports the venue's
 * contact details verbatim (it's told to). Best-effort: returns nulls
 * when nothing matches. The email match deliberately ignores the
 * traveller's own address by skipping anything we'd never expect a
 * venue to print — but in practice the agent only writes the VENUE's
 * details here, so a plain match is safe.
 */
function extractContacts(message: string): {
  email: string | null;
  phone: string | null;
} {
  const emailMatch = message.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  // A phone: optional +, then 7-20 chars of digits / spaces / dashes /
  // parens. Trim trailing punctuation. Require at least 7 digits so we
  // don't grab a date or party size.
  const phoneMatch = message.match(
    /\+?\d[\d\s().-]{6,18}\d/,
  );
  const phone =
    phoneMatch && (phoneMatch[0].match(/\d/g)?.length ?? 0) >= 7
      ? phoneMatch[0].trim()
      : null;
  return {
    email: emailMatch ? emailMatch[0] : null,
    phone,
  };
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
