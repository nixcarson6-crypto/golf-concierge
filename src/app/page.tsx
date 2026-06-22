import { auth } from "@clerk/nextjs/server";
import { Landing } from "@/components/landing/landing";

export default async function LandingPage() {
  const { userId } = await auth();
  // "Plan my trip" jumps straight to a fresh quiz when signed in
  // (/trips/new seeds a DRAFT then redirects into the questions). Signed
  // out → /sign-up, which bounces back here after auth.
  const primaryHref = userId ? "/trips/new" : "/sign-up";

  return <Landing userId={userId} primaryHref={primaryHref} />;
}
