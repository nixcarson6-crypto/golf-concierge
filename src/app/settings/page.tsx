import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { SignOutButton } from "@clerk/nextjs";
import { AccountButton } from "@/components/account-button";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SettingsClient } from "./settings-client";
import { BillingSection } from "@/components/billing-section";
import { TravelerSection } from "@/components/settings/traveler-section";
import { DangerZone } from "@/components/settings/danger-zone";
import { getSavedCard } from "@/lib/payments/saved-card";
import { stripeConfigured } from "@/lib/stripe";
import { pushPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const [subs, savedCard] = await Promise.all([
    db.pushSubscription.findMany({
      where: { userId: user.id },
      select: { id: true, endpoint: true, userAgent: true, createdAt: true },
    }),
    getSavedCard(user.id),
  ]);

  return (
    <div className="min-h-dvh bg-concierge-radial">
      <header className="container py-6 flex items-center justify-between">
        <Link
          href="/dashboard"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition text-sm"
        >
          <ChevronLeft className="size-4" /> Dashboard
        </Link>
        <AccountButton name={user.name} email={user.email} />
      </header>

      <main className="container pb-24 max-w-2xl">
        <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
          Settings
        </p>
        <h1 className="text-display text-4xl tracking-tight">Your account</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Traveler details, payment method, and notifications.
        </p>

        <div className="mt-8 space-y-6">
          <section className="glass rounded-2xl p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">Account</h2>
              <SignOutButton redirectUrl="/">
                <button
                  type="button"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground transition"
                >
                  Sign out
                </button>
              </SignOutButton>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{user.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="num-tabular">{user.email}</dd>
            </dl>
          </section>

          <TravelerSection
            profile={{
              legalGivenName: user.legalGivenName,
              legalFamilyName: user.legalFamilyName,
              dateOfBirth: user.dateOfBirth
                ? user.dateOfBirth.toISOString().slice(0, 10)
                : null,
              gender: user.gender,
              phone: user.phone,
              addressLine1: user.addressLine1,
              addressCity: user.addressCity,
              addressState: user.addressState,
              addressPostalCode: user.addressPostalCode,
              addressCountry: user.addressCountry,
              defaultOriginAirport: user.defaultOriginAirport,
            }}
          />

          <BillingSection
            initialCard={savedCard}
            stripeEnabled={stripeConfigured()}
          />

          <SettingsClient
            vapidKey={pushPublicKey()}
            subscriptions={subs.map((s) => ({
              id: s.id,
              endpoint: s.endpoint,
              userAgent: s.userAgent,
              createdAt: s.createdAt.toISOString(),
            }))}
          />

          <DangerZone />
        </div>
      </main>
    </div>
  );
}
