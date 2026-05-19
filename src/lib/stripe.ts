import Stripe from "stripe";
import { optionalEnv } from "./env";

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (_stripe) return _stripe;
  const key = optionalEnv("STRIPE_SECRET_KEY");
  _stripe = new Stripe(key || "sk_test_unset", {
    typescript: true,
    appInfo: { name: "Golf Concierge", version: "0.1.0" },
  });
  return _stripe;
}

export function stripeConfigured() {
  return Boolean(optionalEnv("STRIPE_SECRET_KEY"));
}
