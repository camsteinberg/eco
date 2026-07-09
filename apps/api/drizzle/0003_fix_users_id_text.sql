-- Wave D follow-up: align the legacy app `users.id` (and the FK columns that
-- reference it) with the TEXT ids Better Auth issues.
--
-- Migration 0002 deliberately OMITTED drizzle-kit's uuid->text ALTER on the
-- strength of a comment that those columns were "already text in every real DB."
-- That assumption was false for production: 0000 created `users.id` as `uuid`
-- (DEFAULT gen_random_uuid()) and nothing ever altered it. The meta snapshot was
-- updated to `text` while the actual DDL was never emitted, so prod stayed `uuid`.
--
-- The drift broke signup once the invite gate was removed: Better Auth's
-- `user.create.after` hook -> finalizeNewUser -> syncUserToAppTable inserts the
-- Better Auth text id into the `uuid` column, which Postgres rejects with
-- "invalid input syntax for type uuid", surfacing as FAILED_TO_CREATE_USER.
--
-- uuid->text is always a valid cast, so this is safe whether the tables are
-- empty or hold legacy rows. The FK columns are converted to match.

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET DATA TYPE text USING "user_id"::text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
