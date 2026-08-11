ALTER TABLE "messages" DROP CONSTRAINT "messages_source_id_connected_sources_id_fk";
--> statement-breakpoint
-- Reordered from drizzle-kit's generated order: the UNIQUE constraint this
-- composite foreign key references must exist before the foreign key that
-- references it can be created — Postgres rejected the original
-- (FK-then-unique) statement order with "there is no unique constraint
-- matching given keys for referenced table".
ALTER TABLE "connected_sources" ADD CONSTRAINT "connected_sources_id_identity_id_key" UNIQUE("id","identity_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_identity_fk" FOREIGN KEY ("source_id","identity_id") REFERENCES "public"."connected_sources"("id","identity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_sources_identity_id_idx" ON "connected_sources" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "messages_identity_occurred_at_idx" ON "messages" USING btree ("identity_id","occurred_at");