import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Tune Neon's pooled connection string for Prisma:
 *  - connection_limit=3: stay small so we don't pile up stale connections
 *    against Neon's auto-suspend (their serverless compute idles after a
 *    few minutes of inactivity, and any held connection across that
 *    boundary gets RST'd → "An existing connection was forcibly closed
 *    by the remote host", code 10054 on Windows / ECONNRESET on POSIX).
 *  - pool_timeout=30: 30s for any single query to grab a connection.
 *  - pgbouncer=true: tells Prisma we're behind PgBouncer (Neon's pooler)
 *    so it disables prepared statements that PgBouncer can't multiplex.
 *    Without this you get cryptic "prepared statement does not exist"
 *    errors after a Neon wake-up.
 *  - connect_timeout=10: don't hang for 30s waiting on a corpse connection.
 */
function buildDatasourceUrl() {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.searchParams.set("connection_limit", "3");
  url.searchParams.set("pool_timeout", "30");
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connect_timeout", "10");
  return url.toString();
}

/**
 * Does an error look like a transient Neon connection RST that a retry
 * can fix? We catch every variant of "the remote side closed the
 * connection" we've seen across Linux/macOS/Windows.
 */
function isTransientConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Closed") ||
    msg.includes("kind: Closed") ||
    msg.includes("Connection terminated") ||
    msg.includes("ECONNRESET") ||
    msg.includes("Connection refused") ||
    msg.includes("forcibly closed") || // Windows / code 10054
    msg.includes("Connection reset") ||
    msg.includes("ConnectionReset") ||
    msg.includes("Server has closed the connection") ||
    msg.includes("Can't reach database server") ||
    msg.includes("server closed the connection")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a single Prisma promise-returning method so it auto-retries on
 * Neon connection RSTs. Up to 3 attempts: immediate, +500ms, +1500ms.
 * That's enough headroom for Neon's compute to fully wake from auto-suspend
 * (typically <2s). Non-transient errors propagate immediately so we
 * never mask a real bug.
 */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  const backoffsMs = [0, 500, 1500];
  let lastErr: unknown;
  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (attempt > 0) await sleep(backoffsMs[attempt]);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientConnectionError(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[db:${label}] transient connection error (attempt ${attempt + 1}/${backoffsMs.length}) — ${msg.slice(0, 140)}`,
      );
    }
  }
  throw lastErr;
}

/**
 * Wrap the Prisma client in a Proxy so EVERY model method
 * (db.trip.findMany, db.user.update, db.itineraryItem.create, …) is
 * automatically retried on Neon RSTs without changing call-site code.
 * The Proxy intercepts model accessors (db.trip), wraps THEIR methods
 * (findMany, etc.), and only retries methods that return promises.
 * Synchronous methods + chainable query builders pass through unchanged.
 */
function wrapPrismaWithRetry(client: PrismaClient): PrismaClient {
  return new Proxy(client, {
    get(target, modelProp, receiver) {
      const model = Reflect.get(target, modelProp, receiver);
      // Top-level Prisma utilities — $transaction, $connect, $disconnect,
      // $extends, $queryRaw, etc. — also wrap their promise returns.
      if (typeof modelProp === "string" && modelProp.startsWith("$")) {
        if (typeof model === "function") {
          return (...args: unknown[]) =>
            callWithRetry(
              () => (model as (...a: unknown[]) => Promise<unknown>).apply(target, args),
              String(modelProp),
            );
        }
        return model;
      }
      // Anything that isn't a model object (e.g. internal symbols) passes
      // through. Models are plain objects with method properties.
      if (model === null || typeof model !== "object") return model;
      return new Proxy(model as Record<string, unknown>, {
        get(modelTarget, methodProp, modelReceiver) {
          const method = Reflect.get(modelTarget, methodProp, modelReceiver);
          if (typeof method !== "function") return method;
          return (...args: unknown[]) => {
            const result = (method as (...a: unknown[]) => unknown).apply(
              modelTarget,
              args,
            );
            // Only wrap thenable returns — Prisma's terminal methods
            // (findMany / findFirst / create / update / delete /
            // upsert / count / aggregate / groupBy) all return
            // PrismaPromise. Builders that return chainable objects
            // pass through.
            if (
              result &&
              typeof (result as { then?: unknown }).then === "function"
            ) {
              return callWithRetry(
                () => Promise.resolve(result as Promise<unknown>),
                `${String(modelProp)}.${String(methodProp)}`,
              );
            }
            return result;
          };
        },
      });
    },
  });
}

const _rawPrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasourceUrl: buildDatasourceUrl(),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = _rawPrisma;

export const db: PrismaClient = wrapPrismaWithRetry(_rawPrisma);

/**
 * Explicit retry wrapper for multi-step DB operations (e.g. delete + N
 * creates inside a build pipeline). Most call sites no longer need it
 * because the prisma client itself now auto-retries every terminal
 * method via the Proxy above — but the helper stays for the cases
 * where you want to retry a sequence as a unit.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  label = "db",
): Promise<T> {
  return callWithRetry(fn, label);
}
