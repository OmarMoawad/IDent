CREATE TABLE "message_priorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"level" text NOT NULL,
	"reason" text NOT NULL,
	"assigned_by" text NOT NULL,
	"rule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"match_type" text NOT NULL,
	"match_value" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_priorities" ADD CONSTRAINT "message_priorities_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_priorities" ADD CONSTRAINT "message_priorities_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_rules" ADD CONSTRAINT "priority_rules_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_priorities_message_idx" ON "message_priorities" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_priorities_identity_level_idx" ON "message_priorities" USING btree ("identity_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX "priority_rules_identity_match_idx" ON "priority_rules" USING btree ("identity_id","match_type","match_value");--> statement-breakpoint
CREATE INDEX "priority_rules_identity_idx" ON "priority_rules" USING btree ("identity_id");