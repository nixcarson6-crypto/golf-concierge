import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { db } from "@/lib/db";
import { requireTripAccess } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export default async function GroupPage({
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
  if (!access.trip) notFound();

  const [members, invites] = await Promise.all([
    db.tripMember.findMany({
      where: { tripId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
    db.tripInvite.findMany({
      where: { tripId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const isOwner = access.role === "OWNER";

  return (
    <div className="container py-8">
      <div className="max-w-2xl">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
          Group
        </p>
        <h1 className="mt-1 text-display text-3xl tracking-tight">
          Who's in.
        </h1>
        <p className="mt-2 text-muted-foreground">
          Invite the group. Each member approves the itinerary and pays their share.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 glass rounded-3xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-display text-lg tracking-tight">Members</h2>
            <Badge variant="muted" size="sm">
              <Users className="size-3" /> {members.length}
            </Badge>
          </div>
          <ul className="divide-y divide-border/60">
            {members.map((m) => (
              <li key={m.id} className="py-3 flex items-center gap-3">
                <Avatar>
                  {m.user?.imageUrl && (
                    <AvatarImage src={m.user.imageUrl} alt={m.name ?? m.email} />
                  )}
                  <AvatarFallback>{initials(m.name ?? m.email)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-tight truncate">
                    {m.name ?? m.email}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {m.email}
                  </p>
                </div>
                <RoleBadge role={m.role} />
                <ApprovalBadge status={m.approvalStatus} />
                <PaymentBadge status={m.paymentStatus} />
              </li>
            ))}
          </ul>

          {invites.length > 0 && (
            <>
              <h3 className="mt-8 text-[10px] uppercase tracking-widest text-muted-foreground">
                Pending invites
              </h3>
              <ul className="mt-3 space-y-2">
                {invites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between rounded-xl border border-border/60 bg-surface-raised/30 px-3 py-2"
                  >
                    <span className="text-sm">{inv.email}</span>
                    <Badge variant="gold" size="sm">
                      Pending
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="glass rounded-3xl p-6">
          <h2 className="text-display text-lg tracking-tight">Invite</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            We'll send an email with a one-click link.
          </p>
          {isOwner ? (
            <div className="mt-5">
              <InviteForm tripId={tripId} />
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              Only the trip owner can invite members.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: "OWNER" | "MEMBER" | "ADMIN" }) {
  if (role === "OWNER") return <Badge variant="gold" size="sm">Owner</Badge>;
  if (role === "ADMIN") return <Badge variant="muted" size="sm">Admin</Badge>;
  return <Badge variant="muted" size="sm">Member</Badge>;
}

function ApprovalBadge({
  status,
}: {
  status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "DECLINED";
}) {
  if (status === "APPROVED") return <Badge variant="emerald" size="sm">Approved</Badge>;
  if (status === "CHANGES_REQUESTED")
    return <Badge variant="warning" size="sm">Changes requested</Badge>;
  if (status === "DECLINED") return <Badge variant="destructive" size="sm">Declined</Badge>;
  return <Badge variant="muted" size="sm">Awaiting approval</Badge>;
}

function PaymentBadge({
  status,
}: {
  status: "UNPAID" | "DEPOSIT_PAID" | "PAID" | "REFUNDED" | "FAILED";
}) {
  if (status === "PAID") return <Badge variant="emerald" size="sm">Paid</Badge>;
  if (status === "DEPOSIT_PAID") return <Badge variant="gold" size="sm">Deposit</Badge>;
  if (status === "FAILED") return <Badge variant="destructive" size="sm">Failed</Badge>;
  return <Badge variant="muted" size="sm">Unpaid</Badge>;
}
