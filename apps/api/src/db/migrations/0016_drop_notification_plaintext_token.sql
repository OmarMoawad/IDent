ALTER TABLE "notification_endpoints" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_endpoints" DROP COLUMN "token";