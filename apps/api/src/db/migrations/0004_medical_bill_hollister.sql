CREATE TABLE "recovery_credentials" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_credentials" ADD CONSTRAINT "recovery_credentials_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;