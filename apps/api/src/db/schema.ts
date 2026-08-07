import { pgTable, serial, timestamp } from "drizzle-orm/pg-core";

/**
 * Phase 0A infra-proving table only — confirms migrations run end to end.
 * Identity/domain schema starts in Phase 0B (see ROADMAP.md), not here.
 */
export const systemHealthChecks = pgTable("system_health_checks", {
  id: serial("id").primaryKey(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
