import type { CalendarApiClient, CalendarEventResource } from "../calendar-api-client.js";

/**
 * In-memory CalendarApiClient for tests — the same fake-at-the-network-
 * boundary convention as fake-gmail-api-client.ts.
 */
export class FakeCalendarApiClient implements CalendarApiClient {
  public calls = 0;
  public lastOptions: { timeMin: Date; maxResults: number } | null = null;

  constructor(private readonly events: CalendarEventResource[] = []) {}

  async listEvents(
    _accessToken: string,
    options: { timeMin: Date; maxResults: number },
  ): Promise<CalendarEventResource[]> {
    this.calls += 1;
    this.lastOptions = options;
    return this.events.slice(0, options.maxResults);
  }
}

export function fakeEvent(overrides: Partial<CalendarEventResource> & { id: string }): CalendarEventResource {
  return {
    summary: "Standup",
    description: null,
    location: null,
    start: "2026-08-20T09:00:00Z",
    end: "2026-08-20T09:15:00Z",
    isAllDay: false,
    status: "confirmed",
    attendees: [],
    ...overrides,
  };
}
