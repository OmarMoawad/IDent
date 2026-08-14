import { CALENDAR_SYNC_MAX_EVENTS, hasCalendarScope } from "./comms-config.js";
import { calendarApiClient, type CalendarApiClient } from "./calendar-api-client-instance.js";
import { getActiveGmailAccessToken } from "./gmail-service.js";
import { type GoogleOAuthClient, googleOAuthClient } from "./google-oauth-client.js";
import { upsertCalendarEvent } from "./calendar-store.js";

export type SyncCalendarResult = {
  sourceId: string;
  eventsSeen: number;
  eventsUpserted: number;
  /** True when the stored grant predates the calendar scope. */
  needsReconnect: boolean;
};

export class CalendarScopeMissingError extends Error {
  constructor() {
    super("This connection was authorized before calendar access was requested. Reconnect to grant it.");
    this.name = "CalendarScopeMissingError";
  }
}

/**
 * An all-day event arrives as a bare `YYYY-MM-DD` with no time or zone.
 * `new Date("2026-08-13")` parses that as UTC midnight, which is the least
 * surprising interpretation for a whole-day marker; the `isAllDay` flag
 * travels with it so the UI can render a day rather than a time.
 */
function parseEventTime(raw: string | null): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Pulls upcoming events from a connected Google source into the shared
 * `calendar_events` table.
 *
 * Ownership and connection-state checks come from
 * getActiveGmailAccessToken — the same path Gmail sync uses — so this
 * function never re-implements them and callers see the same three
 * connected-source errors gmail-routes.ts already maps to HTTP statuses.
 * Despite the name, that function is the Google token accessor for this
 * connection, not a Gmail-specific one.
 */
export async function syncCalendarEvents(
  identityId: string,
  sourceId: string,
  oauthClient: GoogleOAuthClient = googleOAuthClient,
  apiClient: CalendarApiClient = calendarApiClient,
  now: Date = new Date(),
): Promise<SyncCalendarResult> {
  const { accessToken, scope } = await getActiveGmailAccessToken(identityId, sourceId, oauthClient);

  // A grant made before this session existed has Gmail scope only. Say so
  // explicitly rather than calling Calendar and surfacing an opaque 403.
  if (!hasCalendarScope(scope)) {
    return { sourceId, eventsSeen: 0, eventsUpserted: 0, needsReconnect: true };
  }

  const events = await apiClient.listEvents(accessToken, {
    timeMin: now,
    maxResults: CALENDAR_SYNC_MAX_EVENTS,
  });

  let eventsUpserted = 0;
  for (const event of events) {
    const startsAt = parseEventTime(event.start);
    // An event with no usable start can't be placed on a calendar; skip it
    // rather than inventing a time, and keep syncing the rest.
    if (!startsAt) continue;

    await upsertCalendarEvent({
      identityId,
      sourceId,
      externalId: event.id,
      title: event.summary,
      description: event.description,
      location: event.location,
      startsAt,
      endsAt: parseEventTime(event.end),
      isAllDay: event.isAllDay,
      attendees: JSON.stringify(
        event.attendees.map((attendee) => ({
          address: attendee.email,
          ...(attendee.displayName ? { name: attendee.displayName } : {}),
        })),
      ),
      status: event.status,
    });
    eventsUpserted += 1;
  }

  return { sourceId, eventsSeen: events.length, eventsUpserted, needsReconnect: false };
}
