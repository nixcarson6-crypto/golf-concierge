import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

export default function SignUpPage() {
  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <header className="px-6 py-5 border-b border-border/60">
        <Link href="/" className="inline-flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg bg-foreground">
            <svg
              viewBox="0 0 24 24"
              className="size-4 text-background"
              fill="currentColor"
              aria-hidden
            >
              <path d="M12 2c1.5 4 4 6.5 8 8-4 1.5-6.5 4-8 8-1.5-4-4-6.5-8-8 4-1.5 6.5-4 8-8Z" />
            </svg>
          </span>
          <span className="text-display text-lg tracking-tight">Pyltrix</span>
        </Link>
      </header>

      <main className="flex-1 grid place-items-center px-4 pb-12 pt-8">
        <div className="w-full max-w-md flex flex-col items-center gap-6">
          <div className="text-center space-y-2">
            <h1 className="text-display text-3xl tracking-tight text-foreground">
              Plan your trip.
            </h1>
            <p className="text-sm text-muted-foreground">
              Answer a few questions and our AI builds your complete golf
              trip — flights, lodging, tee times, dining, transport — then
              books the whole thing for you.
            </p>
          </div>

          <SignUp
            appearance={{
              elements: {
                card: "bg-background border border-border shadow-[0_24px_80px_-24px_rgb(0_0_0/0.18)] w-full rounded-2xl",
                rootBox: "w-full",
                formButtonPrimary:
                  "bg-foreground text-background hover:bg-foreground/90",
                footerActionLink: "text-foreground hover:text-foreground/80",
              },
            }}
          />

          <p className="text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-foreground underline underline-offset-4 hover:text-foreground/80 font-medium"
            >
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
