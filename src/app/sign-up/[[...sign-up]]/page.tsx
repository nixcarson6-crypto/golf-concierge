import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

export default function SignUpPage() {
  return (
    <div className="min-h-dvh flex flex-col bg-concierge-radial">
      <header className="px-6 py-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-foreground tracking-wide"
        >
          <span className="text-lg font-semibold tracking-[0.3em]">
            PYLTRIX
          </span>
        </Link>
      </header>

      <main className="flex-1 grid place-items-center px-4 pb-12">
        <div className="w-full max-w-md flex flex-col items-center gap-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Plan your trip
            </h1>
            <p className="text-sm text-muted-foreground">
              Create your account to start booking complete golf trips —
              flights, hotels, tee times, and dining — in a single chat.
            </p>
          </div>

          <SignUp
            appearance={{
              elements: {
                card: "bg-[#0f0f15] border border-[#2a2a35] shadow-2xl w-full",
                rootBox: "w-full",
              },
            }}
          />

          <p className="text-xs text-muted-foreground text-center">
            Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-[#d6b274] hover:text-[#e0bf85] font-medium"
            >
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
