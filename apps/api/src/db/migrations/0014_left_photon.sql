CREATE TABLE "notification_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_endpoints_identity_id_unique" UNIQUE("identity_id"),
	CONSTRAINT "notification_endpoints_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "action_url" text;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD CONSTRAINT "notification_endpoints_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;