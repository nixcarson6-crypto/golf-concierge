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
};
