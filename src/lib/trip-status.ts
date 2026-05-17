import type { TripStatus } from "@prisma/client";

export function tripStatusLabel(s: TripStatus): string {
  switch (s) {
    case "DRAFT":
      return "Draft";
    case "PLANNING":
      return "Planning";
    case "AWAITING_APPROVAL":
      return "Awaiting approval";
    case "APPROVED":
      return "Approved";
    case "BOOKING":
      return "Booking";
    case "BOOKED":
      return "Booked";
    case "COMPLETED":
      return "Completed";
    case "CANCELLED":
      return "Cancelled";
  }
}
