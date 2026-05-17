import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { stripeConfigured } from "@/lib/stripe";
import { CreatePaymentLinksButton } from "./create-links-button";
import { CreditCard } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  let access;
  try {
    access = await requireTripAccess(tripId);
  } catch {
    notFound();
  }
  const trip = access.trip;
  if (!trip) notFound();

  const [members, payments, currentItinerary] = await Promise.all([
    db.tripMember.findMany({
      where: { tripId },
      orderBy: { createdAt: "asc" },
    }),
    db.payment.findMany({
      where: { tripId },
      orderBy: { createdAt: "desc" },
    }),
    db.itinerary.findFirst({
      where: { tripId, status: { in: ["CURRENT", "APPROVED"] } },
      orderBy: { version: "desc" },
    }),
  ]);

  const perPerson = currentItinerary?.perPersonCost ?? 0;
  const totalDue = members.length * perPerson;
  const totalPaid = payments
    .filter((p) => p.status === "SUCCEEDED")
    .reduce((s, p) => s + p.amount, 0);
  const isOwner = access.role === "OWNER";

  return (
    <div className="container py-8">
      <div className="max-w-2xl">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Payments
        </p>
        <h1 className="mt-1 text-display text-3xl tracking-tight">
          Split, tracked, done.
        </h1>
        <p className="mt-2 text-muted-foreground">
          Per-person Stripe links. Real-time payment status. No spreadsheet.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <Metric label="Per person" value={formatCurrency(perPerson / 100)} />
        <Metric label="Total due" value={formatCurrency(totalDue / 100)} />
        <Metric label="Collected" value={formatCurrency(totalPaid / 100)} accent />
      </div>

      <div className="mt-6 glass rounded-3xl p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-display text-lg tracking-tight">Members</h2>
          {isOwner && (
            <CreatePaymentLinksButton
              tripId={tripId}
              disabled={!stripeConfigured() || !currentItinerary}
              reason={
                !stripeConfigured()
                  ? "Stripe is not configured yet"
                  : !currentItinerary
                    ? "Itinerary not ready"
                    : null
              }
            />
          )}
        </div>

        <ul className="mt-4 divide-y divide-border/60">
          {members.map((m) => {
            const memberPayments = payments.filter((p) => p.memberId === m.id);
            const paid = memberPayments
              .filter((p) => p.status === "SUCCEEDED")
              .reduce((s, p) => s + p.amount, 0);
            const isPaid = paid >= perPerson && perPerson > 0;
            return (
              <li key={m.id} className="py-3 flex items-center gap-3">
                <div className="size-9 rounded-xl bg-surface-raised border border-border grid place-items-center text-xs text-muted-foreground">
                  <CreditCard className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-tight truncate">
                    {m.name ?? m.email}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {m.email}
                  </p>
                </div>
                <div className="text-right num-tabular">
                  <p className="text-sm">
                    {formatCurrency(paid / 100)}{" "}
                    <span className="text-muted-foreground text-xs">
                      / {formatCurrency(perPerson / 100)}
                    </span>
                  </p>
                </div>
                {isPaid ? (
                  <Badge variant="emerald" size="sm">Paid</Badge>
                ) : (
                  <Badge variant="muted" size="sm">Pending</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 text-display text-2xl num-tabular ${accent ? "text-[hsl(var(--gold))]" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
