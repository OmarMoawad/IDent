ALTER TABLE "notification_endpoints" DROP CONSTRAINT "notification_endpoints_token_unique";--> statement-breakpoint
ALTER TABLE "notification_endpoints" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD CONSTRAINT "notification_endpoints_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
-- Backfill: hash any existing plaintext token so the NOT NULL in the next
-- migration has something to hold. sha256 of the UTF-8 bytes, hex-encoded —
-- the exact shape node's createHash("sha256").digest("hex") produces, so a
-- token minted before this migration still resolves afterwards.
UPDATE "notification_endpoints" SET "token_hash" = encode(sha256("token"::bytea), 'hex') WHERE "token_hash" IS NULL AND "token" IS NOT NULL;--> statement-breakpoint
-- An endpoint with neither is unusable and cannot be recovered (the
-- plaintext was never stored elsewhere); drop it rather than block the
-- migration. The owner re-mints one from the UI.
DELETE FROM "notification_endpoints" WHERE "token_hash" IS NULL;
