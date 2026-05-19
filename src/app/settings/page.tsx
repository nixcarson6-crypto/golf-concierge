import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SettingsClient } from "./settings-client";
import { pushPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const subs = await db.pushSubscription.findMany({
    where: { userId: user.id },
    select: { id: true, endpoint: true, userAgent: true, createdAt: true },
  });

  return (
    <div className="min-h-dvh bg-concierge-radial">
      <header className="container py-6 flex items-center justify-between">
        <Link
          href="/dashboard"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition text-sm"
        >
          <ChevronLeft className="size-4" /> Dashboard
        </Link>
        <UserButton afterSignOutUrl="/" />
      </header>

      <main className="container pb-24 max-w-2xl">
        <p className="text-xs uppercase tracking-widest text-muted-foreground mb-1">
          Settings
        </p>
        <h1 className="text-display text-4xl tracking-tight">You</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Notification preferences and connected devices.
        </p>

        <div className="mt-8 space-y-6">
          <section className="glass rounded-2xl p-6">
            <h2 className="text-sm font-medium">Account</h2>
            <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{user.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="num-tabular">{user.email}</dd>
            </dl>
          </section>

          <SettingsClient
            vapidKey={pushPublicKey()}
            subscriptions={subs.map((s) => ({
              id: s.id,
              endpoint: s.endpoint,
              userAgent: s.userAgent,
              createdAt: s.createdAt.toISOString(),
            }))}
          />
        </div>
      </main>
    </div>
  );
}
