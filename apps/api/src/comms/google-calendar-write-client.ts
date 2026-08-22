import type { WriteOutcome } from "./google-mail-write-client.js";

/**
 * Phase 2 session 5 — the Google Calendar write adapter.
 *
 * The only mutation it performs is setting the *authenticated* attendee's
 * response to `accepted` on one event. It fetches the event first, finds the
 * attendee Google marks as `self`, and:
 *
 * - if that attendee is already `accepted`, reports a known idempotent
 *   success rather than patching again;
 * - otherwise patches only that attendee's `responseStatus`, leaving every
 *   other attendee and every other field untouched.
 *
 * A timeout is resolved by re-fetching the attendee's response — never by a
 * blind retry. No other attendee's response, and no event content, is ever
 * modified. Tokens and raw responses stay out of logs and outcome codes.
 */

export type AcceptInvitationInput = {
  providerEventId: string;
  calendarId?: string;
};

export interface CalendarWriteClient {
  acceptInvitation(accessToken: string, input: AcceptInvitationInput): Promise<WriteOutcome>;
  lookupAcceptanceOutcome(accessToken: string, input: AcceptInvitationInput): Promise<WriteOutcome>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type CalendarAttendee = { email?: string; self?: boolean; responseStatus?: string };
type CalendarEventResource = { attendees?: CalendarAttendee[] };

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

function eventUrl(calendarId: string, eventId: string): string {
  return `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

export class RealGoogleCalendarWriteClient implements CalendarWriteClient {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  async acceptInvitation(accessToken: string, input: AcceptInvitationInput): Promise<WriteOutcome> {
    const calendarId = input.calendarId ?? "primary";

    let event: CalendarEventResource | null;
    try {
      const response = await this.fetchImpl(eventUrl(calendarId, input.providerEventId), {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return mapHttpFailure(response.status);
      event = (await response.json().catch(() => null)) as CalendarEventResource | null;
    } catch {
      return { status: "outcome_unknown", code: "event_state_unavailable" };
    }

    const attendees = event?.attendees ?? [];
    const self = attendees.find((a) => a.self);
    // Not an attendee (or the invite is gone): the action is no longer
    // actionable, and that is a definite failure, not an ambiguity.
    if (!self) return { status: "failed", code: "not_an_attendee" };
    if (self.responseStatus === "accepted") return { status: "succeeded", duplicate: true };

    // Patch only the self attendee's response; leave everyone else as-is.
    const patchedAttendees = attendees.map((a) => (a.self ? { ...a, responseStatus: "accepted" } : a));
    try {
      const patch = await this.fetchImpl(eventUrl(calendarId, input.providerEventId), {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ attendees: patchedAttendees }),
      });
      if (patch.ok) return { status: "succeeded" };
      return mapHttpFailure(patch.status);
    } catch {
      return this.lookupAcceptanceOutcome(accessToken, input);
    }
  }

  async lookupAcceptanceOutcome(accessToken: string, input: AcceptInvitationInput): Promise<WriteOutcome> {
    const calendarId = input.calendarId ?? "primary";
    try {
      const response = await this.fetchImpl(eventUrl(calendarId, input.providerEventId), {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return { status: "outcome_unknown", code: "event_state_unavailable" };
      const event = (await response.json().catch(() => null)) as CalendarEventResource | null;
      const self = (event?.attendees ?? []).find((a) => a.self);
      return self?.responseStatus === "accepted"
        ? { status: "succeeded" }
        : { status: "outcome_unknown", code: "acceptance_unconfirmed" };
    } catch {
      return { status: "outcome_unknown", code: "event_state_unavailable" };
    }
  }
}

function mapHttpFailure(status: number): WriteOutcome {
  if (status === 401 || status === 403) return { status: "failed", code: "unauthorized" };
  if (status === 404) return { status: "failed", code: "not_found" };
  if (status === 429) return { status: "failed", code: "rate_limited" };
  if (status >= 500) return { status: "outcome_unknown", code: "provider_error" };
  return { status: "failed", code: "provider_rejected" };
}
