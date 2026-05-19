import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<{ trip?: string }>;
}) {
  const { trip } = await searchParams;
  return (
    <div className="min-h-dvh grid place-items-center px-4 bg-concierge-radial">
      <div className="glass rounded-3xl p-10 text-center max-w-md">
        <div className="mx-auto size-12 rounded-2xl bg-surface-raised border border-border grid place-items-center text-muted-foreground">
          <X className="size-5" />
        </div>
        <h1 className="mt-5 text-display text-2xl tracking-tight">No charge made.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You can return any time and complete payment.
        </p>
        {trip && (
          <Button asChild className="mt-6" variant="outline">
            <Link href={`/trips/${trip}/payments`}>Back to payments</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
