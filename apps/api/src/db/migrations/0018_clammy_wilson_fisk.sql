CREATE TABLE "assistant_action_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"confirming_session_id" uuid NOT NULL,
	"payload_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_action_approvals_action_key" UNIQUE("action_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_action_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"detail" text DEFAULT '{}' NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_action_audit_events_seq_key" UNIQUE("action_id","seq")
);
--> statement-breakpoint
CREATE TABLE "assistant_elevation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_action_id" uuid,
	CONSTRAINT "assistant_elevation_events_consumed_by_key" UNIQUE("consumed_by_action_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"requesting_session_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"canonical_payload" text NOT NULL,
	"payload_digest" text NOT NULL,
	"retrieval_slice" text NOT NULL,
	"preconditions" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"operation_key" text NOT NULL,
	"outcome_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_pending_actions_operation_key_key" UNIQUE("operation_key")
);
--> statement-breakpoint
ALTER TABLE "assistant_action_approvals" ADD CONSTRAINT "assistant_action_approvals_action_id_assistant_pending_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."assistant_pending_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_action_approvals" ADD CONSTRAINT "assistant_action_approvals_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_action_approvals" ADD CONSTRAINT "assistant_action_approvals_confirming_session_id_sessions_id_fk" FOREIGN KEY ("confirming_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_action_audit_events" ADD CONSTRAINT "assistant_action_audit_events_action_id_assistant_pending_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."assistant_pending_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_elevation_events" ADD CONSTRAINT "assistant_elevation_events_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_elevation_events" ADD CONSTRAINT "assistant_elevation_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_elevation_events" ADD CONSTRAINT "assistant_elevation_events_consumed_by_action_id_assistant_pending_actions_id_fk" FOREIGN KEY ("consumed_by_action_id") REFERENCES "public"."assistant_pending_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD CONSTRAINT "assistant_pending_actions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_actions" ADD CONSTRAINT "assistant_pending_actions_requesting_session_id_sessions_id_fk" FOREIGN KEY ("requesting_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_action_approvals_identity_idx" ON "assistant_action_approvals" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "assistant_action_audit_events_action_idx" ON "assistant_action_audit_events" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "assistant_elevation_events_identity_idx" ON "assistant_elevation_events" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "assistant_pending_actions_identity_idx" ON "assistant_pending_actions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "assistant_pending_actions_status_expiry_idx" ON "assistant_pending_actions" USING btree ("status","expires_at");--> statement-breakpoint
-- Session 5: immutability and append-only, enforced in the database rather
-- than only in application code. What a human approved cannot be altered
-- before it executes, and the audit trail cannot be rewritten or pruned.
CREATE OR REPLACE FUNCTION assistant_pending_actions_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.identity_id <> OLD.identity_id
     OR NEW.requesting_session_id <> OLD.requesting_session_id
     OR NEW.action_type <> OLD.action_type
     OR NEW.schema_version <> OLD.schema_version
     OR NEW.canonical_payload <> OLD.canonical_payload
     OR NEW.payload_digest <> OLD.payload_digest
     OR NEW.retrieval_slice <> OLD.retrieval_slice
     OR NEW.preconditions <> OLD.preconditions
     OR NEW.operation_key <> OLD.operation_key
     OR NEW.expires_at <> OLD.expires_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'assistant_pending_actions: immutable column may not be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER assistant_pending_actions_immutable
  BEFORE UPDATE ON "assistant_pending_actions"
  FOR EACH ROW EXECUTE FUNCTION assistant_pending_actions_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION assistant_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % may not be updated or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER assistant_action_approvals_append_only
  BEFORE UPDATE OR DELETE ON "assistant_action_approvals"
  FOR EACH ROW EXECUTE FUNCTION assistant_append_only_guard();--> statement-breakpoint
CREATE TRIGGER assistant_action_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "assistant_action_audit_events"
  FOR EACH ROW EXECUTE FUNCTION assistant_append_only_guard();