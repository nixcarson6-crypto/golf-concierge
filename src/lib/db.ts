import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Neon's PgBouncer pooler + Prisma work best with a small connection_limit so
// Prisma doesn't exhaust the pool while background AI tasks are running.
// pool_timeout gives each query 30 s to acquire a connection before erroring.
function buildDatasourceUrl() {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.searchParams.set("connection_limit", "5");
  url.searchParams.set("pool_timeout", "30");
  return url.toString();
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasourceUrl: buildDatasourceUrl(),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/**
 * Retry a DB operation once on transient Neon connection failures.
 * Neon's serverless tier closes idle connections aggressively (~30s),
 * which Prisma surfaces as `kind: Closed` mid-build. A single retry
 * almost always succeeds because the pool re-establishes the
 * connection on the next attempt. Non-connection errors propagate
 * immediately so we don't mask real bugs.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  label = "db",
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTransient =
      msg.includes("Closed") ||
      msg.includes("kind: Closed") ||
      msg.includes("Connection terminated") ||
      msg.includes("ECONNRESET") ||
      msg.includes("Connection refused");
    if (!isTransient) throw err;
    console.warn(
      `[db:${label}] transient connection error — retrying once: ${msg.slice(0, 120)}`,
    );
    // Small backoff so the pool has time to recover.
    await new Promise((r) => setTimeout(r, 250));
    return await fn();
  }
}
