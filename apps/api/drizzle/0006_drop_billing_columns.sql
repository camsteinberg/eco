-- Billing removal: Eco is free, with no tiers and no subscriptions, so the
-- users table no longer carries a subscription tier or a payment-processor
-- customer id. Both columns were only ever written by the (now deleted)
-- billing routes and the free-tier default on signup.
--
-- IF EXISTS keeps this safe on a database that never received either column.

ALTER TABLE "users" DROP COLUMN IF EXISTS "subscription_tier";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id";
