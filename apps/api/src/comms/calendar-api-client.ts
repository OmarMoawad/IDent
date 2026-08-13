/**
 * The seam calendar-sync-service.ts calls through to fetch events —
 * the calendar counterpart of gmail-api-client.ts, and split from it for
 * the same reason: a fake stands in during tests, so no session needs a
 * real Google account or network access to exercise sync logic.
 */
export type CalendarEventResource = {
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** RFC-3339 timestamp, or a bare YYYY-MM-DD for an all-day event. */
  start: string | null;
  end: string | null;
  isAllDay: boolean;
  status: string | null;
  attendees: Array<{ email: string; displayName?: string | null }>;
};

export interface CalendarApiClient {
  /** Upcoming events, soonest first, from `timeMin` onwards. */
  listEvents(accessToken: string, options: { timeMin: Date; maxResults: number }): Promise<CalendarEventResource[]>;
}

export class CalendarApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarApiError";
  }
}

const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type GoogleEventTime = { dateTime?: string; date?: string };
type GoogleEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: Array<{ email?: string; displayName?: string }>;
};

/**
 * Google distinguishes timed events (`dateTime`) from all-day events
 * (`date`, a bare calendar day with no time or zone). Collapsing the two
 * would silently shift an all-day event by the viewer's UTC offset, so the
 * distinction is preserved and surfaced as `isAllDay`.
 */
function readEventTime(time: GoogleEventTime | undefined): { value: string | null; isAllDay: boolean } {
  if (time?.dateTime) return { value: time.dateTime, isAllDay: false };
  if (time?.date) return { value: time.date, isAllDay: true };
  return { value: null, isAllDay: false };
}

export function normalizeGoogleEvent(event: GoogleEvent): CalendarEventResource | null {
  if (!event.id) return null;
  const start = readEventTime(event.start);
  const end = readEventTime(event.end);
  if (!start.value) return null;

  return {
    id: event.id,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: start.value,
    end: end.value,
    isAllDay: start.isAllDay,
    status: event.status ?? null,
    attendees: (event.attendees ?? [])
      .filter((attendee): attendee is { email: string; displayName?: string } => Boolean(attendee.email))
      .map((attendee) => ({ email: attendee.email, displayName: attendee.displayName ?? null })),
  };
}

export class RealCalendarApiClient implements CalendarApiClient {
  async listEvents(
    accessToken: string,
    options: { timeMin: Date; maxResults: number },
  ): Promise<CalendarEventResource[]> {
    const params = new URLSearchParams({
      timeMin: options.timeMin.toISOString(),
      maxResults: String(options.maxResults),
      // Expand recurring events into concrete instances; a bare recurring
      // event carries a recurrence rule this code would have to evaluate
      // itself, and getting RRULE right is not this session's job.
      singleEvents: "true",
      orderBy: "startTime",
    });

    const response = await fetch(`${EVENTS_ENDPOINT}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      // Status only — a Google error body can echo request context.
      throw new CalendarApiError(`Google Calendar returned status ${response.status}.`);
    }

    const body = (await response.json().catch(() => null)) as { items?: GoogleEvent[] } | null;
    return (body?.items ?? []).map(normalizeGoogleEvent).filter((event): event is CalendarEventResource => event !== null);
  }
}
