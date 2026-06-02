import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "golf-concierge",
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export type Events = {
  "trip/itinerary.approved": {
    data: { tripId: string; itineraryId: string; userId: string };
  };
  "trip/itinerary.refine_requested": {
    data: { tripId: string; instruction: string; userId: string };
  };
  "trip/booking.failed": {
    data: { tripId: string; itineraryItemId: string };
  };
  "trip/summary.generate_requested": {
    data: { tripId: string };
  };
  /** Autonomous browser-agent booking request. The route handler creates
   *  the Booking row synchronously then fires this so the long-running
   *  agent loop can run outside the request lifecycle (via Inngest). */
  "trip/booking.agent_requested": {
    data: {
      tripId: string;
      bookingId: string;
      itineraryItemId: string;
      userId: string;
    };
  };
};
