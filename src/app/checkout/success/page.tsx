import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ trip?: string }>;
}) {
  const { trip } = await searchParams;
  return (
    <div className="min-h-dvh grid place-items-center px-4 bg-concierge-radial">
      <div className="glass rounded-3xl p-10 text-center max-w-md">
        <div className="mx-auto size-12 rounded-2xl bg-[hsl(var(--emerald)/0.12)] border border-[hsl(var(--emerald)/0.3)] grid place-items-center text-[hsl(var(--emerald))]">
          <Check className="size-5" />
        </div>
        <h1 className="mt-5 text-display text-2xl tracking-tight">You're paid up.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The group dashboard updates in real time. You can close this tab.
        </p>
        {trip && (
          <Button asChild className="mt-6" variant="gold">
            <Link href={`/trips/${trip}`}>Back to the trip</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
