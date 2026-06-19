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

/**
 * SAFETY NET (launch-critical): guarantee a booking NEVER strands in a
 * non-terminal state. `runBrowserBookingInner` writes a terminal status on
 * every PLANNED path, but an unhandled throw in prep (before the withAgentRun
 * wrapper), or a true engine HANG past the time cap, would leave the booking
 * in SEARCHING forever — an eternal spinner the customer sees and the concierge
 * queue (which only lists FAILED / NEEDS_REVIEW) never catches. This wrapper
 * closes both holes: a try/catch routes any unhandled error to the queue, and
 * a watchdog routes a hang there too. We use NEEDS_REVIEW (not FAILED) because
 * a hang MIGHT have actually completed on the venue's side — a human verifies.
 */
export async function runBrowserBooking(args: {
  tripId: string;
  bookingId: string;
  itineraryItemId: string;
  userId: string;
}): Promise<void> {
  // Hard ceiling ABOVE every per-type time cap (LODGING 540s + retry, etc.).
  // If we blow past this, the run is hung — route it to the concierge queue.
  const WATCHDOG_MS = 13 * 60_000;
  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    void failSafeToReview(
      args,
      "Agent exceeded the hard time ceiling — routed to concierge to finalize.",
    );
  }, WATCHDOG_MS);
  // Don't let the watchdog keep the process alive on its own.
  (watchdog as unknown as { unref?: () => void }).unref?.();
  try {
    await runBrowserBookingInner(args);
  } catch (err) {
    console.error(
      "[browser-booking] unhandled error — routing to concierge queue:",
      err,
    );
    await failSafeToReview(
      args,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    settled = true;
    clearTimeout(watchdog);
  }
}

/**
 * Flip a booking to NEEDS_REVIEW so it lands in the concierge queue with an
 * honest customer-facing status — but ONLY if it isn't already terminal
 * (never clobber a CONFIRMED/FAILED outcome the inner run already wrote).
 */
async function failSafeToReview(
  args: { tripId: string; bookingId: string; itineraryItemId: string },
  reason: string,
): Promise<void> {
  try {
    const b = await db.booking.findUnique({
      where: { id: args.bookingId },
      select: { status: true },
    });
    if (!b) return;
    if (
      b.status === "CONFIRMED" ||
      b.status === "FAILED" ||
      b.status === "CANCELLED" ||
      b.status === "NEEDS_REVIEW"
    ) {
      return; // already terminal — leave it alone
    }
    await db.booking.update({
      where: { id: args.bookingId },
      data: { status: "NEEDS_REVIEW", lastError: reason.slice(0, 1000) },
    });
    await db.itineraryItem
      .update({
        where: { id: args.itineraryItemId },
        data: {
          confirmationState: "HOLDING",
          status: "Pyltrix concierge is finalizing this",
        },
      })
      .catch(() => {});
    await postInternalNudge({ tripId: args.tripId }).catch(() => {});
    console.warn(
      `[browser-booking] booking ${args.bookingId} → NEEDS_REVIEW (safety net): ${reason.slice(0, 200)}`,
    );
  } catch (e) {
    console.error("[browser-booking] failSafeToReview itself failed:", e);
  }
}

async function runBrowserBookingInner(args: {
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
  // GOLF with no Places website must STILL try — never instant-fail to
  // "reservations by phone". A course named after a sub-venue ("The King's
  // Course") often has no standalone Google site, but it books on the resort's
  // own page. Start the agent at a web search for the course's tee times so it
  // can FIND and drive the real booking. Hotels/cars keep the honest fail —
  // they're searched API-first and the agent genuinely needs a real site.
  const golfSearchStart =
    item.type === "TEE_TIME"
      ? `https://www.google.com/search?q=${encodeURIComponent(
          `${item.title}${item.location ? ` ${item.location}` : ""} tee times book online`,
        )}`
      : null;
  const startUrl =
    golfOverrideUrl ?? places.website ?? golfSearchStart ?? (item.location ?? "").trim();
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

  // MVP "review before charging" (Carson's call): the agent fills everything to
  // the card step and STOPS for a one-tap customer approval before any money
  // moves. ON by default; the customer's approval (approve-price) re-runs the
  // booking with approvedPriceCents set, which turns this OFF so the re-run
  // pays. Golf is pay-at-course (no upfront charge to review), and pay-at-
  // property hotels never reach a card step, so neither is slowed. Flip to
  // full-auto later with BOOKING_REQUIRE_PAYMENT_REVIEW=false.
  const requirePaymentReview =
    optionalEnv("BOOKING_REQUIRE_PAYMENT_REVIEW") !== "false" &&
    approvedPriceCents == null &&
    item.type !== "TEE_TIME";

  // Instant guest autofill payload — the deterministic per-step fill that
  // types known traveler data in ~100ms instead of the agent transcribing
  // field-by-field at ~10s a step.
  const nationalPhone = traveler.phone.replace(/^\+1/, "").replace(/[^\d]/g, "");
  // Infer the RESIDENCE state when the profile has none, so autofill can fill
  // the (often required) "State of residence" field directly. Priority:
  //   1) the phone AREA CODE — the traveler's actual number, the best proxy
  //      for where they LIVE (903 → Texas).
  //   2) origin airport — weak/last resort (you fly FROM a gateway, e.g. PHX
  //      for a Cabo trip, which is NOT where you reside — this filled "Arizona"
  //      for a Texas customer, so it's now the fallback, not the primary).
  const AREA_CODE_STATE: Record<string, string> = {
    "907":"Alaska","205":"Alabama","251":"Alabama","256":"Alabama","334":"Alabama","938":"Alabama",
    "480":"Arizona","520":"Arizona","602":"Arizona","623":"Arizona","928":"Arizona",
    "479":"Arkansas","501":"Arkansas","870":"Arkansas",
    "209":"California","213":"California","310":"California","323":"California","408":"California","415":"California","424":"California","510":"California","530":"California","559":"California","562":"California","619":"California","626":"California","650":"California","657":"California","661":"California","707":"California","714":"California","747":"California","760":"California","805":"California","818":"California","831":"California","858":"California","909":"California","916":"California","925":"California","949":"California","951":"California",
    "303":"Colorado","719":"Colorado","720":"Colorado","970":"Colorado",
    "203":"Connecticut","475":"Connecticut","860":"Connecticut",
    "302":"Delaware","202":"District of Columbia",
    "239":"Florida","305":"Florida","321":"Florida","352":"Florida","386":"Florida","407":"Florida","561":"Florida","727":"Florida","754":"Florida","772":"Florida","786":"Florida","813":"Florida","850":"Florida","904":"Florida","941":"Florida","954":"Florida",
    "229":"Georgia","404":"Georgia","470":"Georgia","478":"Georgia","678":"Georgia","706":"Georgia","762":"Georgia","770":"Georgia","912":"Georgia",
    "808":"Hawaii","208":"Idaho","986":"Idaho",
    "217":"Illinois","224":"Illinois","309":"Illinois","312":"Illinois","331":"Illinois","618":"Illinois","630":"Illinois","708":"Illinois","773":"Illinois","815":"Illinois","847":"Illinois","872":"Illinois",
    "219":"Indiana","260":"Indiana","317":"Indiana","463":"Indiana","574":"Indiana","765":"Indiana","812":"Indiana","930":"Indiana",
    "319":"Iowa","515":"Iowa","563":"Iowa","641":"Iowa","712":"Iowa",
    "316":"Kansas","620":"Kansas","785":"Kansas","913":"Kansas",
    "270":"Kentucky","502":"Kentucky","606":"Kentucky","859":"Kentucky",
    "225":"Louisiana","318":"Louisiana","337":"Louisiana","504":"Louisiana","985":"Louisiana",
    "207":"Maine","240":"Maryland","301":"Maryland","410":"Maryland","443":"Maryland","667":"Maryland",
    "339":"Massachusetts","351":"Massachusetts","413":"Massachusetts","508":"Massachusetts","617":"Massachusetts","774":"Massachusetts","781":"Massachusetts","857":"Massachusetts","978":"Massachusetts",
    "231":"Michigan","248":"Michigan","269":"Michigan","313":"Michigan","517":"Michigan","586":"Michigan","616":"Michigan","734":"Michigan","810":"Michigan","906":"Michigan","947":"Michigan","989":"Michigan",
    "218":"Minnesota","320":"Minnesota","507":"Minnesota","612":"Minnesota","651":"Minnesota","763":"Minnesota","952":"Minnesota",
    "228":"Mississippi","601":"Mississippi","662":"Mississippi","769":"Mississippi",
    "314":"Missouri","417":"Missouri","573":"Missouri","636":"Missouri","660":"Missouri","816":"Missouri",
    "406":"Montana","308":"Nebraska","402":"Nebraska","531":"Nebraska",
    "702":"Nevada","725":"Nevada","775":"Nevada","603":"New Hampshire",
    "201":"New Jersey","551":"New Jersey","609":"New Jersey","732":"New Jersey","848":"New Jersey","856":"New Jersey","862":"New Jersey","908":"New Jersey","973":"New Jersey",
    "505":"New Mexico","575":"New Mexico",
    "212":"New York","315":"New York","332":"New York","347":"New York","516":"New York","518":"New York","585":"New York","607":"New York","631":"New York","646":"New York","680":"New York","716":"New York","718":"New York","838":"New York","845":"New York","914":"New York","917":"New York","929":"New York","934":"New York",
    "252":"North Carolina","336":"North Carolina","704":"North Carolina","743":"North Carolina","828":"North Carolina","910":"North Carolina","919":"North Carolina","980":"North Carolina","984":"North Carolina",
    "701":"North Dakota",
    "216":"Ohio","234":"Ohio","330":"Ohio","380":"Ohio","419":"Ohio","440":"Ohio","513":"Ohio","567":"Ohio","614":"Ohio","740":"Ohio","937":"Ohio",
    "405":"Oklahoma","539":"Oklahoma","580":"Oklahoma","918":"Oklahoma",
    "458":"Oregon","503":"Oregon","541":"Oregon","971":"Oregon",
    "215":"Pennsylvania","267":"Pennsylvania","272":"Pennsylvania","412":"Pennsylvania","484":"Pennsylvania","570":"Pennsylvania","610":"Pennsylvania","717":"Pennsylvania","724":"Pennsylvania","814":"Pennsylvania","878":"Pennsylvania",
    "401":"Rhode Island",
    "803":"South Carolina","843":"South Carolina","854":"South Carolina","864":"South Carolina",
    "605":"South Dakota",
    "423":"Tennessee","615":"Tennessee","629":"Tennessee","731":"Tennessee","865":"Tennessee","901":"Tennessee","931":"Tennessee",
    "210":"Texas","214":"Texas","254":"Texas","281":"Texas","325":"Texas","346":"Texas","361":"Texas","409":"Texas","430":"Texas","432":"Texas","469":"Texas","512":"Texas","682":"Texas","713":"Texas","737":"Texas","806":"Texas","817":"Texas","830":"Texas","832":"Texas","903":"Texas","915":"Texas","936":"Texas","940":"Texas","956":"Texas","972":"Texas","979":"Texas",
    "385":"Utah","435":"Utah","801":"Utah","802":"Vermont",
    "276":"Virginia","434":"Virginia","540":"Virginia","571":"Virginia","703":"Virginia","757":"Virginia","804":"Virginia",
    "206":"Washington","253":"Washington","360":"Washington","425":"Washington","509":"Washington","564":"Washington",
    "304":"West Virginia","681":"West Virginia",
    "262":"Wisconsin","414":"Wisconsin","608":"Wisconsin","715":"Wisconsin","920":"Wisconsin","307":"Wyoming",
  };
  const US_AIRPORT_STATE: Record<string, string> = {
    DFW: "Texas", DAL: "Texas", IAH: "Texas", HOU: "Texas", AUS: "Texas", SAT: "Texas",
    LAX: "California", SFO: "California", SAN: "California", SJC: "California",
    JFK: "New York", LGA: "New York", EWR: "New Jersey",
    ORD: "Illinois", MDW: "Illinois", ATL: "Georgia", MIA: "Florida", MCO: "Florida",
    TPA: "Florida", FLL: "Florida", BOS: "Massachusetts", SEA: "Washington",
    DEN: "Colorado", PHX: "Arizona", LAS: "Nevada", DTW: "Michigan",
    MSP: "Minnesota", PHL: "Pennsylvania", PIT: "Pennsylvania", CLT: "North Carolina",
    RDU: "North Carolina", BNA: "Tennessee", DCA: "Virginia", IAD: "Virginia",
    BWI: "Maryland", SLC: "Utah", PDX: "Oregon", STL: "Missouri", MCI: "Missouri",
  };
  // Area code = first 3 of the 10-digit national number.
  const areaCode = nationalPhone.length >= 10 ? nationalPhone.slice(0, 3) : "";
  const inferredState =
    traveler.addressState ||
    AREA_CODE_STATE[areaCode] ||
    (traveler.homeAirport
      ? US_AIRPORT_STATE[traveler.homeAirport.toUpperCase().slice(0, 3)] ?? null
      : null);
  const autofill = {
    firstName: traveler.givenName,
    lastName: traveler.familyName,
    email: traveler.email,
    phone: traveler.phone,
    phoneNational: nationalPhone || traveler.phone.replace(/[^\d]/g, ""),
    title: (traveler.gender === "f" ? "Ms." : "Mr.") as "Mr." | "Ms.",
    addressLine1: traveler.addressLine1,
    city: traveler.addressCity,
    state: inferredState,
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
    // HOTEL AGENT KILL SWITCH (MVP): if the browser agent isn't reliable
    // enough on luxury hotels, set HOTEL_AGENT_DISABLED=true. Hotels that
    // LiteAPI/Hotelbeds DO cover still book above (API-first); only the
    // UNCOVERED ones land here, and instead of a slow agent run we hand the
    // customer a direct booking link — exactly the "rely on the APIs, link the
    // rest" fallback. Flip the env off again to re-enable the agent.
    if (process.env.HOTEL_AGENT_DISABLED === "true") {
      console.log(
        `[book] HOTEL_AGENT_DISABLED — linking ${item.title} instead of the agent.`,
      );
      await markBookingFailed({
        booking,
        itemId: item.id,
        tripId: args.tripId,
        failureReason: "form_not_found",
        message:
          "No partner API covers this hotel — book it directly with the link below.",
        fallbackContact: { website: startUrl, phone: places.phone ?? null },
      });
      return;
    }
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
      const useStagehand = engine !== "computer-use" && engine !== "skyvern";
      const useSkyvern = engine === "skyvern";
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
          // SKYVERN ENGINE (BOOKING_ENGINE=skyvern): hand the whole booking to
          // Skyvern's hosted vision agent. Steel/Browserbase + Stagehand remain
          // the default + fallback — this only runs when explicitly selected.
          if (useSkyvern) {
            const { runSkyvernBooking } = await import("./skyvern-runner");
            const result = await runSkyvernBooking({
              startUrl,
              navigationGoal: goal.firstUserMessage,
              payload: {
                check_in: task.isoDate,
                check_out: task.isoCheckOut,
                tee_time: task.displayTime ?? null,
                party_size: task.traveler.partySize,
                first_name: traveler.givenName,
                last_name: traveler.familyName,
                email: traveler.email,
                phone: traveler.phone,
                address_line1: traveler.addressLine1,
                city: traveler.addressCity,
                state: traveler.addressState,
                postal_code: traveler.addressPostalCode,
                country: traveler.addressCountry ?? "US",
              },
              timeoutMs:
                Number(optionalEnv("BROWSER_AGENT_TIMEOUT_MS")) || 360_000,
              onStep: async (label) => {
                await bridgeNudge(label);
              },
              onSessionReady: async (sessionUrl) => {
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
                  /* best-effort */
                }
              },
            });
            return {
              outcome: result.outcome,
              finalScreenshot: result.finalScreenshot,
            };
          }
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
              // 6-MINUTE CEILING. Carson's call: let the agent actually FINISH
              // the booking — 5-6 min is acceptable, only 8+ is too long. So
              // give complex luxury forms room to complete (instead of bailing
              // to concierge at 4 min). Past 6 min it hands off. The UI tells
              // the customer WHY a longer one is taking a bit. Override per-
              // deploy with BROWSER_AGENT_TIMEOUT_MS.
              timeoutMs:
                Number(optionalEnv("BROWSER_AGENT_TIMEOUT_MS")) || 360_000,
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
              requirePaymentReview,
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
              // Cars: the SAME cheapest-priced-card picker + add-on/extras skip
              // the hotel flow uses — picks the cheapest vehicle when results
              // render and blows past the protection/extras page in one click.
              selectVehicle: item.type === "TRANSPORT",
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
      // RESORT GOLF → CONCIERGE-ARRANGE-WITH-STAY. A tee time that has no
      // online booking (members/guest-only, pro-shop/phone only) isn't a
      // failure — booking the hotel makes the customer an eligible guest, and
      // Pyltrix's concierge arranges the tee time with the pro shop on their
      // behalf. So we frame it as an in-progress concierge task (NEEDS_REVIEW),
      // not a red "couldn't book". Only for golf, only for the no-online-form
      // failure codes — every other outcome is untouched.
      const isResortGolf =
        item.type === "TEE_TIME" &&
        verified.status === "FAILED" &&
        (verified.failureCode === "members_only" ||
          verified.failureCode === "form_not_found");
      const venueName =
        (item.title.split(/[—–-]/)[0] || "").trim() || "the resort";
      const nextMeta: Record<string, unknown> = {
        ...existingMeta,
        vendorConfirmation: verified.evidence ?? null,
        // For needs_review verdicts the verifier has no failure code — fall
        // back to the agent's own reason so price_approval reaches the UI.
        failureReason: verified.failureCode ?? rawReason,
        quotedPriceCents,
        // Tells the concierge queue + customer UI this is a "we're arranging
        // it with your stay" task, with the pro-shop contact to call.
        arrangeWithStay: isResortGolf || undefined,
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
          // Resort golf → NEEDS_REVIEW (concierge arranges with the stay), not
          // FAILED — it still lands in the queue, but reads as in-progress.
          status: isResortGolf ? "NEEDS_REVIEW" : toBookingStatus(verified),
          confirmationCode: verified.confirmationCode,
          confirmedAt: verified.status === "CONFIRMED" ? new Date() : null,
          screenshotUrl: screenshotDataUrl,
          lastError:
            verified.status === "FAILED" && !isResortGolf
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
          confirmationState: isResortGolf
            ? "HOLDING"
            : toConfirmationState(verified),
          status:
            verified.status === "CONFIRMED"
              ? `Booked${verified.confirmationCode ? ` · ${verified.confirmationCode}` : ""}`
              : isResortGolf
                ? `Arranging your tee time with ${venueName} as part of your stay`
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
  // a meal/activity PREFIX ("Dinner — Sunset Monalisa", "Lunch at X",
  // "Round at Valhalla", "Encore at The King's") AND golf items carry a
  // round/day SUFFIX ("The King's Course — Round 1", "PGA Centenary — encore
  // round"). BOTH pollute the search — a real run looked up "The King's
  // Course — Round 1", found no website, and the agent had nothing to book
  // (it landed on a Google search). Strip both so we look up the actual venue.
  const venueName = item.title
    .replace(
      /^(dinner|lunch|breakfast|brunch|drinks|cocktails|round|tee\s*time|spa|massage|encore|farewell(\s*round)?|round\s*\d+)\s*(—|–|-|:|at)\s*/i,
      "",
    )
    .replace(
      /\s*(—|–|-|:)\s*(round\s*\d+|encore(\s*round)?|farewell(\s*round)?|day\s*\d+|morning|afternoon)\s*$/i,
      "",
    )
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
