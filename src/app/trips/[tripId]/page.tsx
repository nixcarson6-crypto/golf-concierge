import { notFound } from "next/navigation";
import { requireTripAccess } from "@/lib/auth";
import { ConciergeWorkspace } from "@/components/concierge/workspace";

export const dynamic = "force-dynamic";

export default async function TripCommandCenterPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  try {
    await requireTripAccess(tripId);
  } catch {
    notFound();
  }
  return <ConciergeWorkspace tripId={tripId} />;
}
