import { db } from "./db";
import { nudge } from "./events";
import type { AuditAction, Prisma } from "@prisma/client";

/**
 * Append-only audit log. Anything that changes trip state should call audit()
 * with the action, a short human title, and optional structured metadata.
 * The UI renders this as a transparent timeline so the group can see exactly
 * what the system did and when.
 */
export type AuditInput = {
  tripId: string;
  action: AuditAction;
  title: string;
  detail?: string;
  actorId?: string | null;
  actorKind?: "user" | "agent" | "system";
  metadata?: Record<string, unknown>;
};

export async function audit(event: AuditInput) {
  try {
    await db.auditEvent.create({
      data: {
        tripId: event.tripId,
        action: event.action,
        title: event.title,
        detail: event.detail ?? null,
        actorId: event.actorId ?? null,
        actorKind: event.actorKind ?? "system",
        metadata: (event.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
    nudge(event.tripId);
  } catch (err) {
    // Never let an audit failure break a real action.
    console.error("[audit]", err);
  }
}
