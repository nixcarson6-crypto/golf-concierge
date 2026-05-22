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
