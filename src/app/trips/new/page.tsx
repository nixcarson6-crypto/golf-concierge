import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { NewTripForm } from "./new-trip-form";

export const dynamic = "force-dynamic";

export default async function NewTripPage() {
  const user = await requireUser();

  async function startTrip(formData: FormData): Promise<void> {
    "use server";
    const me = await requireUser();
    const title =
      ((formData.get("title") as string | null) ?? "").trim() ||
      "Untitled trip";
    const trip = await db.trip.create({
      data: {
        ownerId: me.id,
        title,
        status: "DRAFT",
        members: {
          create: {
            userId: me.id,
            email: me.email,
            name: me.name,
            role: "OWNER",
            joinedAt: new Date(),
            approvalStatus: "APPROVED",
          },
        },
        chatMessages: {
          create: {
            userId: me.id,
            role: "ASSISTANT",
            content:
              "Welcome — tell me about the trip. Where you're thinking, when, how many guys, the vibe, and any non-negotiables. I'll take it from there.",
          },
        },
      },
    });
    redirect(`/trips/${trip.id}`);
  }

  return (
    <div className="min-h-dvh bg-concierge-radial grid place-items-center px-4">
      <NewTripForm action={startTrip} ownerName={user.name?.split(" ")[0] ?? null} />
    </div>
  );
}
