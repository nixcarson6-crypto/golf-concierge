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
import { sendEmail, renderBookingConfirmationEmail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { withAgentRun } from "@/lib/ai/orchestrator";
import { withSession, navigate } from "./runtime";
import { randomBytes } from "node:crypto";
import { runAgent } from "./agent";
import { buildGoal } from "./goal";
import { buildBookingTask } from "./types";

/**
 * A strong, single-venue account password for venues that force registration
 * to book. Always satisfies the common upper/lower/digit/symbol rule. Stored
 * on the booking (not a Pyltrix credential) so it's recoverable; the customer
 * can also reset it via their own email since registration uses that email.
 */
function generateAccountPassword(): string {
  const rand = randomBytes(12).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return `Pyltrix-${rand.slice(0, 10)}9!`;
}
import {
  verifyOutcome,
  toBookingStatus,
  toConfirmationState,
  type RawBookingOutcome,
} from "./outcome";
import { buildCardProviderForBooking } from "./card-provider";
import { resolveGolfBookingUrl } from "../golf-platform-url";
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
      include: {
        itinerary: {
          select: {
            tripId: true,
            trip: { select: { groupSize: true, constraints: true } },
          },
        },
      },
    }),
    db.user.findUnique({
      where: { id: args.userId },
      select: {
        email: true,
        legalGivenName: true,
        legalFamilyName: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
        defaultOriginAirport: true,
        addressLine1: true,
        addressCity: true,
        addressState: true,
        addressPostalCode: true,
        addressCountry: true,
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
  // GOLF: some operators bot-wall their marketing site (Troon's
  // troonnorthgolf.com 403s automation) while the real tee-time booking lives
  // on a separate platform (golfwithaccess.com). Route straight there so the
  // agent doesn't get blocked at a door it can't open.
  const golfOverrideUrl =
    item.type === "TEE_TIME"
      ? resolveGolfBookingUrl({
          title: item.title,
          location: item.location,
          placesWebsite: places.website,
        })
      : null;
  if (golfOverrideUrl) {
    console.log(
      `[book] ${item.title}: using platform booking URL ${golfOverrideUrl} instead of ${places.website ?? "(no site)"} (marketing site is bot-walled).`,
    );
  }
  const startUrl =
    golfOverrideUrl ?? places.website ?? (item.location ?? "").trim();
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
    addressLine1: user.addressLine1 ?? null,
    addressCity: user.addressCity ?? null,
    addressState: user.addressState ?? null,
    addressPostalCode: user.addressPostalCode ?? null,
    addressCountry: user.addressCountry ?? null,
    gender: user.gender ?? null,
    // Residence proxy: the trip's origin airport (or the user's sticky home
    // airport). Forms demanding state/country of residence use its metro.
    homeAirport:
      ((item.itinerary.trip?.constraints as { originAirport?: string } | null)
        ?.originAirport ??
        user.defaultOriginAirport) ||
      null,
    // Party size = how many people the reservation is for. The trip's
    // groupSize is the source of truth (the customer answered "2 players");
    // a per-item metadata override wins if the itinerary set one (e.g. a
    // dinner for a subset). Only fall back to 1 when we truly have nothing —
    // booking 2 travelers as "1 adult" was a real bug.
    partySize:
      (item.metadata as { partySize?: number } | null)?.partySize ??
      item.itinerary.trip?.groupSize ??
      1,
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

  // Hotel checkouts ALWAYS require a billing/home address — Country, Street,
  // City, Zip are * required on every booking engine (synxis/SHR, Belmond,
  // etc.). With no saved address the agent reaches the checkout, fills the
  // name/email/phone, then stalls on the address fields it has no data for
  // until the wall-clock cap aborts it (a real run died at the $5,365 Lodge
  // Torrey Pines checkout this way). Fail FAST with the exact fix instead of a
  // 7-minute grind — the customer adds their address once and every future
  // hotel books end-to-end.
  if (item.type === "LODGING" && !traveler.addressLine1) {
    await markBookingFailed({
      booking,
      itemId: item.id,
      tripId: args.tripId,
      failureReason: "ambiguous",
      message:
        "Add your home address in your profile (Street, City, State, Zip) — hotel checkouts require it to book. Then tap Book again and the agent completes the whole reservation.",
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
  // Managed password for venues that force account creation to book (Carson's
  // call: auto-register + STORE the password so the customer can recover
  // access / reset via their email). Reuse any password minted on a prior
  // attempt so a retry never spawns a second account; otherwise mint a strong
  // one and persist it on the booking now (before the agent might use it).
  const bookingMeta = (booking.metadata as Record<string, unknown> | null) ?? {};
  const priorAccount = bookingMeta.venueAccount as { password?: string } | undefined;
  const accountPassword = priorAccount?.password ?? generateAccountPassword();
  if (!priorAccount?.password) {
    await db.booking
      .update({
        where: { id: booking.id },
        data: {
          metadata: {
            ...bookingMeta,
            venueAccount: { email: traveler.email, password: accountPassword },
          } as object,
        },
      })
      .catch(() => {});
  }

  const task = buildBookingTask({ request, traveler, venue, accountPassword });

  // HYBRID PRICE-APPROVAL GATE: by default the gate is the headroomed
  // estimate (task.budgetCents). Once the customer has APPROVED the real
  // price (approve-price endpoint writes approvedPriceCents), the gate is
  // lifted entirely so the re-run pays without re-asking. No estimate
  // (or $25k+ budget) ⇒ no gate.
  const approvedPriceCents =
    typeof bookingMeta.approvedPriceCents === "number"
      ? (bookingMeta.approvedPriceCents as number)
      : null;
  // Golf is exempt from the price gate: its green-fee 'cost' is a DISPLAY
  // estimate from the build's web lookup (Carson's ask — show a price), and we
  // don't want that to ever pause a tee-time booking for "price approval". Golf
  // is pay-at-course anyway, so there's no charge to gate. Hotels/cars keep it.
  const priceGateCents =
    approvedPriceCents != null || item.type === "TEE_TIME"
      ? null
      : task.budgetCents;

  // Instant guest autofill payload — the deterministic per-step fill that
  // types known traveler data in ~100ms instead of the agent transcribing
  // field-by-field at ~10s a step.
  const nationalPhone = traveler.phone.replace(/^\+1/, "").replace(/[^\d]/g, "");
  const autofill = {
    firstName: traveler.givenName,
    lastName: traveler.familyName,
    email: traveler.email,
    phone: traveler.phone,
    phoneNational: nationalPhone || traveler.phone.replace(/[^\d]/g, ""),
    title: (traveler.gender === "f" ? "Ms." : "Mr.") as "Mr." | "Ms.",
    addressLine1: traveler.addressLine1,
    city: traveler.addressCity,
    state: traveler.addressState,
    postal: traveler.addressPostalCode,
    countryName:
      traveler.addressCountry === "US" || !traveler.addressCountry
        ? "United States"
        : traveler.addressCountry,
  };
  const goal = buildGoal(task);

  // ---------------------------------------------------------- 3.5 (API-first)
  // HOTELS: try the bedbank APIs before the browser agent — LiteAPI first,
  // then Hotelbeds. If either carries the property, this books it in seconds
  // and we're done; any miss/error falls through to the next provider and
  // finally the agent. The itinerary AI already picked the best hotel with
  // no knowledge of API coverage — this only changes HOW we book it.
  if (item.type === "LODGING") {
    const hotelArgs = {
      bookingId: booking.id,
      itineraryItemId: item.id,
      hotelName: item.title,
      location: item.address ?? item.location,
      checkin: task.isoDate,
      checkout: task.isoCheckOut,
      adults: task.traveler.partySize,
      traveler,
    };
    const { tryLiteApiHotelBooking } = await import("../liteapi-hotel");
    const { tryHotelbedsHotelBooking } = await import("../hotelbeds-hotel");
    const { tryRateHawkHotelBooking } = await import("../ratehawk-hotel");
    const providers = [
      { name: "LiteAPI", fn: tryLiteApiHotelBooking },
      { name: "Hotelbeds", fn: tryHotelbedsHotelBooking },
      { name: "RateHawk", fn: tryRateHawkHotelBooking },
    ];
    for (const p of providers) {
      const api = await p.fn(hotelArgs);
      if (api.booked) {
        console.log(`[book] ${item.title} booked via ${p.name} — skipping agent.`);
        try {
          await postInternalNudge({ tripId: args.tripId });
        } catch {}
        return;
      }
      console.log(`[book] ${p.name} didn't book ${item.title} (${api.reason}).`);
    }
    console.log(`[book] No API carried ${item.title} — using browser agent.`);
  }

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
      const attemptOnce = async (attempt: number) => {
        try {
          if (useStagehand) {
            const { runStagehandBooking, browserbaseRegionFor } = await import(
              "./stagehand-runner"
            );
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
              // Proxy + captcha-solving slows EVERY request (residential-proxy
              // hop) — worth it for bot-protected GOLF (Troon/Access verify
              // walls, which appear DEEP in the flow so we can't afford to
              // fail-then-retry), but pure overhead for HOTELS/cars, which
              // rarely bot-protect and, when they do (Marriott/Akamai), fail
              // FAST at landing → a retry then turns the proxy on. So: golf
              // always; everything else only on a retry.
              solveCaptchas:
                captchaOn && (item.type === "TEE_TIME" || attempt > 1),
              // Advanced Stealth is a Browserbase SCALE-plan feature — sending
              // it on a Developer/Startup plan can error the session. So only
              // request it when EXPLICITLY enabled (BROWSERBASE_PREMIUM /
              // _ADVANCED_STEALTH), not automatically on retries. Retries still
              // get their unblock from a FRESH residential IP + captcha-solving
              // (solveCaptchas → proxies), which every paid plan includes.
              advancedStealth: stealthOn,
              // Hard per-attempt cap, sized per booking type. Hotels run the
              // longest flow (splash → widget → dates → guests → search →
              // room → rate → guest form) — ~30+ steps. Hotels get 6 min
              // (Sonnet plans more reliably but a touch slower per step, and
              // reaching the payment step reliably beats shaving a minute).
              // LODGING 7 min: Marriott-class chain sites died ON the guest-info page
              // at 6:01 — better to finish at 6:30 than abort at the finish line.
              // Typical engines still complete in 3-4 and never feel the cap.
              // Golf/transport get 4 — Laguna Phuket's booking widget hit the
              // old 3-min cap at step 18 while still working; Carson's bar is
              // "payment step in ≤4 min" for golf too, so give it the full 4.
              // BROWSER_AGENT_TIMEOUT_MS overrides. LODGING 9 min (long
              // checkout). TEE_TIME 7 min: Access/golfwithaccess flows run
              // longer than expected (route → search → slot → rate → players →
              // guest/login → confirm) — a real Troon run reached checkout step
              // 3 and got cut off at the old 4-min cap mid-flow. Cars stay 4.
              timeoutMs:
                Number(optionalEnv("BROWSER_AGENT_TIMEOUT_MS")) ||
                (item.type === "LODGING"
                  ? 540_000
                  : item.type === "TEE_TIME"
                    ? 420_000
                    : 240_000),
              maxSteps,
              // Run the browser in the region nearest the venue so each of
              // the ~25 actions has a short round-trip (an Italian hotel
              // booked from US-West sends every click across the Atlantic).
              region: browserbaseRegionFor(venue.address),
              // Just-in-time payment: when the agent reaches the card step,
              // this charges the customer + mints a single-use virtual card
              // and the runner types it in. Returns `unavailable` (→ clean
              // needs_review, no card entered) when Stripe isn't configured
              // or the customer hasn't saved a card.
              cardProvider,
              priceGateCents,
              autofill,
              // Set the date deterministically (zero-LLM) for every type that
              // has one on a web form: hotels (check-in + check-out), golf (the
              // single tee date), and CAR RENTALS (the pick-up date). Only
              // hotels carry a second date; golf + cars are single-date.
              checkinISO:
                item.type === "LODGING" ||
                item.type === "TEE_TIME" ||
                item.type === "TRANSPORT"
                  ? task.isoDate
                  : null,
              checkoutISO: item.type === "LODGING" ? task.isoCheckOut : null,
              // Golf: click the tee-time slot nearest the requested time the
              // moment the list renders (zero LLM) — the agent's #1 stall was
              // sitting on a full ForeUp/Chronogolf slot list without clicking.
              selectTeeSlot: item.type === "TEE_TIME",
              // Hotels: click the cheapest room card the moment the rooms/suites
              // grid renders (zero LLM) — the agent's #1 hotel stall is sitting
              // on the room list.
              selectRoom: item.type === "LODGING",
              teeTimeLabel:
                item.type === "TEE_TIME" ? task.displayTime ?? null : null,
              onStep: async (label) => {
                await bridgeNudge(label);
              },
              onSessionReady: async (sessionUrl) => {
                // Persist the live-view URL the instant the session opens so
                // the app can show a "Watch live" link DURING the run (it 404s
                // once the session ends).
                if (!sessionUrl) return;
                try {
                  const cur = await db.booking.findUnique({
                    where: { id: booking.id },
                    select: { metadata: true },
                  });
                  const meta =
                    (cur?.metadata as Record<string, unknown> | null) ?? {};
                  await db.booking.update({
                    where: { id: booking.id },
                    data: {
                      metadata: { ...meta, liveViewUrl: sessionUrl } as object,
                    },
                  });
                  await bridgeNudge("Live view ready…");
                } catch {
                  /* best-effort — never block the booking */
                }
              },
            });
            return {
              outcome: result.outcome,
              finalScreenshot: result.finalScreenshot,
            };
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
      // NOTE: "timeout" is deliberately NOT retryable. A venue that can't be
      // booked inside the 3-min cap won't finish on a retry either — retrying
      // just stacks 3 + 3 + 3 = 9 min, the exact grind we're killing. Timeout
      // → straight to the clean fallback. Captcha/ambiguous still retry (they
      // fail fast now and a fresh IP/stealth session genuinely flips them).
      const RETRYABLE = new Set(["captcha_blocked", "ambiguous"]);
      const MAX_ATTEMPTS = Number(optionalEnv("BROWSER_AGENT_MAX_ATTEMPTS")) || 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          await bridgeNudge(
            `Hit a verification wall — trying again (${attempt}/${MAX_ATTEMPTS})…`,
          );
          await sleep(1500);
        }
        const r = await attemptOnce(attempt);
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
      const rawReason = (outcome as { failureReason?: string | null }).failureReason ?? null;
      const quotedPriceCents =
        (outcome as { priceCents?: number | null }).priceCents ??
        (existingMeta.quotedPriceCents as number | undefined) ??
        null;
      const nextMeta: Record<string, unknown> = {
        ...existingMeta,
        vendorConfirmation: verified.evidence ?? null,
        // For needs_review verdicts the verifier has no failure code — fall
        // back to the agent's own reason so price_approval reaches the UI.
        failureReason: verified.failureCode ?? rawReason,
        quotedPriceCents,
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

      // Write the REAL checkout total back onto the item (Carson's ask): when
      // the agent reached the payment step it read the venue's exact total for
      // these dates/party — far better than a web-search estimate. This
      // replaces "at checkout" with the confirmed price in the UI.
      const itemMeta = (item.metadata as Record<string, unknown> | null) ?? {};
      const writeRealPrice =
        quotedPriceCents != null && quotedPriceCents > 0;
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
          ...(writeRealPrice
            ? {
                cost: quotedPriceCents,
                metadata: {
                  ...itemMeta,
                  priceConfirmed: true,
                  priceBasis: "Confirmed at checkout",
                  priceSource: startUrl,
                } as object,
              }
            : {}),
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

      // Proof email — when the agent really booked a venue, send the
      // customer the same "Booked ✓" reassurance with the venue's own
      // confirmation. Best-effort; no-ops without RESEND_API_KEY and never
      // blocks the run.
      if (verified.status === "CONFIRMED" && traveler.email) {
        try {
          const appUrl =
            optionalEnv("NEXT_PUBLIC_APP_URL") ?? "https://pyltrix.com";
          const charged =
            verified.amountChargedCents != null && verified.amountChargedCents > 0;
          const mail = renderBookingConfirmationEmail({
            name: traveler.givenName || null,
            tripLabel: item.title,
            lines: [
              {
                title: item.title,
                detail: charged
                  ? `$${(verified.amountChargedCents! / 100).toFixed(2)} charged`
                  : "Reserved",
                confirmationCode: verified.confirmationCode,
                paymentMode: charged ? "pay_now" : "pay_at_property",
              },
            ],
            tripUrl: `${appUrl}/trips/${args.tripId}`,
          });
          await sendEmail({
            to: traveler.email,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          });
        } catch (e) {
          console.warn("[browser-booking] confirmation email failed:", e);
        }
      }

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
