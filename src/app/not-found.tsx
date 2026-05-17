import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-dvh grid place-items-center px-4 bg-concierge-radial text-center">
      <div className="max-w-md">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          404
        </p>
        <h1 className="mt-2 text-display text-4xl tracking-tight">
          We couldn't find that.
        </h1>
        <p className="mt-3 text-muted-foreground">
          The page may have moved, or you may not have access.
        </p>
        <Button asChild variant="gold" className="mt-6">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
