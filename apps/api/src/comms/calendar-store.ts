import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { calendarEvents, reminders } from "../db/schema.js";

export type CalendarEvent = {
  id: string;
  identityId: string;
  sourceId: string;
  externalId: string;
  title: string | null;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isAllDay: boolean;
  attendees: string | null;
  status: string | null;
};

const eventColumns = {
  id: calendarEvents.id,
  identityId: calendarEvents.identityId,
  sourceId: calendarEvents.sourceId,
  externalId: calendarEvents.externalId,
  title: calendarEvents.title,
  description: calendarEvents.description,
  location: calendarEvents.location,
  startsAt: calendarEvents.startsAt,
  endsAt: calendarEvents.endsAt,
  isAllDay: calendarEvents.isAllDay,
  attendees: calendarEvents.attendees,
  status: calendarEvents.status,
};

export type NewCalendarEvent = Omit<CalendarEvent, "id">;

/**
 * Upserts on (sourceId, externalId) so re-syncing the same calendar is
 * idempotent — the same discipline comms/store.ts's upsertMessage uses.
 * An edited event (moved, renamed, cancelled) updates in place rather than
 * becoming a duplicate.
 */
export async function upsertCalendarEvent(input: NewCalendarEvent): Promise<CalendarEvent> {
  const [row] = await db
    .insert(calendarEvents)
    .values(input)
    .onConflictDoUpdate({
      target: [calendarEvents.sourceId, calendarEvents.externalId],
      set: {
        title: input.title,
        description: input.description,
        location: input.location,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        isAllDay: input.isAllDay,
        attendees: input.attendees,
        status: input.status,
      },
    })
    .returning(eventColumns);
  return row;
}

/**
 * Identity-scoped, in chronological order. A calendar is read forwards —
 * "what's next" — which is the opposite of the inbox's newest-first, and
 * calendar_events_identity_starts_at_idx serves this directly.
 */
export async function findCalendarEventsByIdentity(
  identityId: string,
  options: { from?: Date; to?: Date; limit?: number } = {},
): Promise<CalendarEvent[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
  const filters = [eq(calendarEvents.identityId, identityId)];
  if (options.from) filters.push(gte(calendarEvents.startsAt, options.from));
  if (options.to) filters.push(lte(calendarEvents.startsAt, options.to));

  return db
    .select(eventColumns)
    .from(calendarEvents)
    .where(and(...filters))
    .orderBy(asc(calendarEvents.startsAt))
    .limit(limit);
}

export type Reminder = {
  id: string;
  identityId: string;
  title: string;
  notes: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

const reminderColumns = {
  id: reminders.id,
  identityId: reminders.identityId,
  title: reminders.title,
  notes: reminders.notes,
  dueAt: reminders.dueAt,
  completedAt: reminders.completedAt,
  createdAt: reminders.createdAt,
};

export async function insertReminder(input: {
  identityId: string;
  title: string;
  notes?: string | null;
  dueAt?: Date | null;
}): Promise<Reminder> {
  const [row] = await db
    .insert(reminders)
    .values({
      identityId: input.identityId,
      title: input.title,
      notes: input.notes ?? null,
      dueAt: input.dueAt ?? null,
    })
    .returning(reminderColumns);
  return row;
}

/**
 * Outstanding reminders first (soonest due, undated last), then completed
 * ones — the order a to-do list is actually read in. `NULLS LAST` is
 * explicit because Postgres sorts nulls first on ASC by default, which
 * would put undated reminders above genuinely urgent ones.
 */
export async function findRemindersByIdentity(
  identityId: string,
  options: { includeCompleted?: boolean } = {},
): Promise<Reminder[]> {
  const filters = [eq(reminders.identityId, identityId)];
  if (!options.includeCompleted) filters.push(isNull(reminders.completedAt));

  return db
    .select(reminderColumns)
    .from(reminders)
    .where(and(...filters))
    .orderBy(sql`${reminders.completedAt} NULLS FIRST`, sql`${reminders.dueAt} ASC NULLS LAST`, desc(reminders.createdAt))
    .limit(200);
}

/**
 * Scoped by identityId on the update itself, so one identity can never
 * complete or edit another's reminder even with a valid id.
 */
export async function setReminderCompletion(
  id: string,
  identityId: string,
  completed: boolean,
): Promise<Reminder | null> {
  const rows = await db
    .update(reminders)
    .set({ completedAt: completed ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(reminders.id, id), eq(reminders.identityId, identityId)))
    .returning(reminderColumns);
  return rows[0] ?? null;
}

export async function deleteReminder(id: string, identityId: string): Promise<boolean> {
  const rows = await db
    .delete(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.identityId, identityId)))
    .returning({ id: reminders.id });
  return rows.length > 0;
}
