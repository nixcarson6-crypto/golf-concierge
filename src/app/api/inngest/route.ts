import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { functions } from "@/lib/jobs";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
