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
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button asChild variant="navy">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
          {/* A Home link for signed-out visitors — "dashboard" alone sends
              them to the sign-in wall with no way to the marketing site. */}
          <Button asChild variant="ghost">
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
