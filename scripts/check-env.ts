#!/usr/bin/env node
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

type Check = { name: string; status: "ok" | "missing" | "fail"; detail?: string };

const REQUIRED = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "ANTHROPIC_API_KEY",
];

const OPTIONAL = [
  "TAVILY_API_KEY",
  "DUFFEL_API_KEY",
  "HOTELBEDS_API_KEY",
  "HOTELBEDS_SECRET",
  "GOLFNOW_API_KEY",
  "LIGHTSPEED_GOLF_API_KEY",
  "OPENTABLE_API_KEY",
  "YELP_FUSION_API_KEY",
  "CARTRAWLER_API_KEY",
  "TRAWICK_API_KEY",
  "UBER_FOR_BUSINESS_TOKEN",
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
  "RESEND_API_KEY",
];

function checkEnv(name: string): Check {
  const v = process.env[name];
  if (!v) return { name, status: "missing" };
  if (
    /^(pk_test_replace|sk_test_replace|sk-ant-replace|paste-your)/i.test(v) ||
    v.endsWith("replace_me")
  ) {
    return { name, status: "fail", detail: "still has placeholder value" };
  }
  return { name, status: "ok" };
}

async function checkDatabase(): Promise<Check> {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    return { name: "Database connection", status: "ok" };
  } catch (err) {
    await prisma.$disconnect().catch(() => {});
    return {
      name: "Database connection",
      status: "fail",
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

function symbol(status: Check["status"]): string {
  if (status === "ok") return "✅";
  if (status === "missing") return "⚪";
  return "❌";
}

async function main() {
  console.log("\nRequired env vars");
  console.log("-".repeat(40));
  let hardFail = 0;
  for (const k of REQUIRED) {
    const c = checkEnv(k);
    console.log(`${symbol(c.status)}  ${k}${c.detail ? `  (${c.detail})` : ""}`);
    if (c.status !== "ok") hardFail++;
  }

  console.log("\nOptional env vars (booking partners, search, etc.)");
  console.log("-".repeat(40));
  for (const k of OPTIONAL) {
    const c = checkEnv(k);
    console.log(`${symbol(c.status)}  ${k}${c.detail ? `  (${c.detail})` : ""}`);
  }

  console.log("\nLive checks");
  console.log("-".repeat(40));
  const db = await checkDatabase();
  console.log(`${symbol(db.status)}  ${db.name}${db.detail ? `\n     ${db.detail}` : ""}`);
  if (db.status !== "ok") hardFail++;

  console.log();
  if (hardFail > 0) {
    console.log(`❌  ${hardFail} blocker(s) — app will not boot cleanly.`);
    process.exit(1);
  }
  console.log("✅  Environment looks good. pnpm dev should boot.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
