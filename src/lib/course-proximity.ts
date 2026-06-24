/**
 * "Are this trip's golf courses still close to where the customer is staying?"
 *
 * When a customer swaps their hotel, the new property might be in a different
 * town from the courses the AI picked around the original hotel. Carson's call:
 * if the courses are now FAR, offer to re-pick courses near the new hotel; if
 * they're still close, leave them alone. This module is the shared truth both
 * the swap endpoint (to decide whether to prompt) and the re-pick endpoint (to
 * decide which courses to replace) use, so they can never disagree.
 *
 * A course is only considered for re-pick if it is BOTH far AND not already
 * confirmed-booked — we never move a round the customer has locked in.
 */

import { db } from "@/lib/db";
import { geocodePlace, distanceMiles, COURSE_FAR_MILES } from "@/lib/geo";

export type FarCourse = {
  itemId: string;
  title: string;
  location: string | null;
  distanceMi: number;
};

export type ProximityResult = {
  /** False when we couldn't place the hotel (no key / not found) — callers
   *  should SKIP the feature entirely rather than guess a wrong answer. */
  hotelGeocoded: boolean;
  /** Unbooked courses farther than COURSE_FAR_MILES from the hotel. */
  far: FarCourse[];
};

/**
 * Assess how far the trip's (unbooked) golf courses are from a hotel anchor.
 */
export async function assessCourseProximity(args: {
  tripId: string;
  hotelName: string;
  hotelLocation: string | null;
}): Promise<ProximityResult> {
  const hotel = await geocodePlace(
    args.hotelLocation
      ? `${args.hotelName}, ${args.hotelLocation}`
      : args.hotelName,
  );
  if (!hotel) return { hotelGeocoded: false, far: [] };

  // Current golf items on the trip. We exclude CONFIRMED-booked rounds below
  // (in code, so null-booking semantics can't surprise us) — those are locked
  // and we never move a round the customer already booked.
  const allCourses = await db.itineraryItem.findMany({
    where: {
      type: "TEE_TIME",
      itinerary: { tripId: args.tripId, status: { in: ["CURRENT", "DRAFT"] } },
    },
    select: {
      id: true,
      title: true,
      location: true,
      booking: { select: { status: true } },
    },
  });
  const courses = allCourses.filter(
    (c) => c.booking?.status !== "CONFIRMED",
  );
  if (courses.length === 0) return { hotelGeocoded: true, far: [] };

  // Geocode courses in parallel; a course we can't place is treated as
  // NOT far (leave it alone) so we never wrongly re-pick on a bad geocode.
  const far: FarCourse[] = [];
  await Promise.all(
    courses.map(async (c) => {
      const coords = await geocodePlace(
        c.location ? `${c.title}, ${c.location}` : c.title,
      );
      if (!coords) return;
      const miles = distanceMiles(hotel, coords);
      if (miles > COURSE_FAR_MILES) {
        far.push({
          itemId: c.id,
          title: c.title,
          location: c.location,
          distanceMi: Math.round(miles),
        });
      }
    }),
  );
  return { hotelGeocoded: true, far };
}
