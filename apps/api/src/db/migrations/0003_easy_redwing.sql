CREATE TABLE "passkey_amk_wraps" (
	"credential_id" uuid PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkey_amk_wraps" ADD CONSTRAINT "passkey_amk_wraps_credential_id_webauthn_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."webauthn_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_amk_wraps" ADD CONSTRAINT "passkey_amk_wraps_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;