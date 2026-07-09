-- Wave D DB-schema teardown: drop the orphaned tables left behind by the old
-- decentralized-network product (routes/features removed across S1-S3b).
--
-- All drops use IF EXISTS + CASCADE so the migration is idempotent and safe
-- across environments with different drift: the drizzle snapshot only ever
-- tracked "miners", but the other tables were created via `db:push` (which
-- does not update the migration journal), so the set of these tables present
-- varies by environment. IF EXISTS drops whatever subset each DB actually has.
--
-- Kept tables (user, session, account, verification, users, sessions, api_keys)
-- are intentionally untouched: they back v1.0 auth + billing. The stale
-- uuid->text ALTERs drizzle-kit emitted for users/sessions/api_keys are an
-- artifact of an out-of-date 0001 snapshot (those columns are already text in
-- every real DB via the Better Auth migration) and are deliberately omitted —
-- this teardown only removes orphan tables.

DROP TABLE IF EXISTS "device_challenges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "devices" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "miner_stats" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "miners" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "model_manifests" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "split_model_configs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "token_transactions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "token_accounts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "contribution_jobs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "referrals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "economy_config" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "canaries" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "spot_checks" CASCADE;
