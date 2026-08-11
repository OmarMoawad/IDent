ALTER TABLE "connected_sources" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "connected_sources" ADD COLUMN "provider_account_email" text;--> statement-breakpoint
ALTER TABLE "oauth_state_challenges" ADD COLUMN "pkce_verifier" text NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_sources" ADD CONSTRAINT "connected_sources_identity_provider_account_key" UNIQUE("identity_id","provider","provider_account_id");