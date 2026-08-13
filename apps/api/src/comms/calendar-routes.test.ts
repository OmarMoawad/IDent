import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { hasCalendarScope, GMAIL_SCOPE, GOOGLE_CALENDAR_SCOPE } from "./comms-config.js";
import { normalizeGoogleEvent } from "./calendar-api-client.js";
import { insertConnectedSource } from "./store.js";
import { upsertCalendarEvent } from "./calendar-store.js";

async function register(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `cal_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  return response.json() as { identityId: string; sessionToken: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("hasCalendarScope", () => {
  it("only reports calendar access when the grant actually includes it", () => {
    // A user can decline individual scopes on the consent screen, so this
    // must be read from the grant, never assumed from the connection.
    expect(hasCalendarScope(`${GMAIL_SCOPE} ${GOOGLE_CALENDAR_SCOPE}`)).toBe(true);
    expect(hasCalendarScope(GMAIL_SCOPE)).toBe(false);
    expect(hasCalendarScope(null)).toBe(false);
    expect(hasCalendarScope("")).toBe(false);
  });
});

describe("normalizeGoogleEvent", () => {
  it("distinguishes an all-day event from a timed one", () => {
    const allDay = normalizeGoogleEvent({ id: "e1", summary: "Holiday", start: { date: "2026-08-20" } });
    expect(allDay).toMatchObject({ isAllDay: true, start: "2026-08-20" });

    const timed = normalizeGoogleEvent({ id: "e2", start: { dateTime: "2026-08-20T09:00:00Z" } });
    expect(timed).toMatchObject({ isAllDay: false, start: "2026-08-20T09:00:00Z" });
  });

  it("drops events with no id or no start rather than inventing values", () => {
    expect(normalizeGoogleEvent({ summary: "no id", start: { date: "2026-08-20" } })).toBeNull();
    expect(normalizeGoogleEvent({ id: "e3", summary: "no start" })).toBeNull();
  });

  it("keeps only attendees that actually have an address", () => {
    const event = normalizeGoogleEvent({
      id: "e4",
      start: { dateTime: "2026-08-20T09:00:00Z" },
      attendees: [{ email: "a@example.com", displayName: "A" }, { displayName: "nobody" }],
    });
    expect(event?.attendees).toEqual([{ email: "a@example.com", displayName: "A" }]);
  });
});

describe("calendar routes", () => {
  it("requires authentication", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/identity/calendar/events" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/identity/reminders" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/identity/reminders", payload: {} })).statusCode).toBe(401);
    await app.close();
  });

  it("lists upcoming events chronologically and hides other identities' events", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const source = await insertConnectedSource({ identityId: alice.identityId, provider: "gmail" });

    await upsertCalendarEvent({
      identityId: alice.identityId,
      sourceId: source.id,
      externalId: "later",
      title: "Later",
      description: null,
      location: null,
      startsAt: new Date("2099-01-02T10:00:00Z"),
      endsAt: null,
      isAllDay: false,
      attendees: null,
      status: "confirmed",
    });
    await upsertCalendarEvent({
      identityId: alice.identityId,
      sourceId: source.id,
      externalId: "sooner",
      title: "Sooner",
      description: null,
      location: null,
      startsAt: new Date("2099-01-01T10:00:00Z"),
      endsAt: null,
      isAllDay: false,
      attendees: null,
      status: "confirmed",
    });

    const events = await app.inject({
      method: "GET",
      url: "/identity/calendar/events",
      headers: bearer(alice.sessionToken),
    });
    // Chronological, not newest-first — a calendar is read forwards.
    expect(events.json().map((event: { title: string }) => event.title)).toEqual(["Sooner", "Later"]);
    // No internal identifiers on the wire.
    expect(Object.keys(events.json()[0])).not.toContain("identityId");
    expect(Object.keys(events.json()[0])).not.toContain("sourceId");

    const bobEvents = await app.inject({
      method: "GET",
      url: "/identity/calendar/events",
      headers: bearer(bob.sessionToken),
    });
    expect(bobEvents.json()).toEqual([]);
    await app.close();
  });

  it("re-syncing the same event updates it instead of duplicating it", async () => {
    const app = buildApp();
    const identity = await register(app);
    const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });
    const base = {
      identityId: identity.identityId,
      sourceId: source.id,
      externalId: "recurring",
      description: null,
      location: null,
      endsAt: null,
      isAllDay: false,
      attendees: null,
      status: "confirmed",
    };
    await upsertCalendarEvent({ ...base, title: "Standup", startsAt: new Date("2099-02-01T09:00:00Z") });
    await upsertCalendarEvent({ ...base, title: "Standup (moved)", startsAt: new Date("2099-02-01T10:00:00Z") });

    const events = await app.inject({
      method: "GET",
      url: "/identity/calendar/events",
      headers: bearer(identity.sessionToken),
    });
    expect(events.json()).toHaveLength(1);
    expect(events.json()[0].title).toBe("Standup (moved)");
    await app.close();
  });

  it("rejects a calendar sync for another identity's source as not found", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const source = await insertConnectedSource({ identityId: alice.identityId, provider: "gmail" });

    const response = await app.inject({
      method: "POST",
      url: `/identity/connections/google/${source.id}/calendar/sync`,
      headers: bearer(bob.sessionToken),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("reminders", () => {
  it("creates, lists, completes, and deletes a reminder", async () => {
    const app = buildApp();
    const identity = await register(app);

    const created = await app.inject({
      method: "POST",
      url: "/identity/reminders",
      headers: bearer(identity.sessionToken),
      payload: { title: "Renew passport", notes: "Book appointment", dueAt: "2026-09-01T10:00:00Z" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const listed = await app.inject({ method: "GET", url: "/identity/reminders", headers: bearer(identity.sessionToken) });
    expect(listed.json()).toHaveLength(1);

    const completed = await app.inject({
      method: "POST",
      url: `/identity/reminders/${id}/completion`,
      headers: bearer(identity.sessionToken),
      payload: { completed: true },
    });
    expect(completed.json().completedAt).toBeTruthy();

    // Completed reminders drop out of the default list but are still there.
    expect((await app.inject({ method: "GET", url: "/identity/reminders", headers: bearer(identity.sessionToken) })).json()).toEqual([]);
    const all = await app.inject({
      method: "GET",
      url: "/identity/reminders?includeCompleted=true",
      headers: bearer(identity.sessionToken),
    });
    expect(all.json()).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/identity/reminders/${id}`,
      headers: bearer(identity.sessionToken),
    });
    expect(deleted.statusCode).toBe(204);
    await app.close();
  });

  it("rejects an empty or oversized title", async () => {
    const app = buildApp();
    const identity = await register(app);
    for (const title of ["", "   ", "x".repeat(201)]) {
      const response = await app.inject({
        method: "POST",
        url: "/identity/reminders",
        headers: bearer(identity.sessionToken),
        payload: { title },
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("never lets one identity see, complete, or delete another's reminder", async () => {
    const app = buildApp();
    const alice = await register(app);
    const bob = await register(app);
    const created = await app.inject({
      method: "POST",
      url: "/identity/reminders",
      headers: bearer(alice.sessionToken),
      payload: { title: "Alice's private reminder" },
    });
    const id = created.json().id;

    expect((await app.inject({ method: "GET", url: "/identity/reminders", headers: bearer(bob.sessionToken) })).json()).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/identity/reminders/${id}/completion`,
          headers: bearer(bob.sessionToken),
          payload: { completed: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "DELETE", url: `/identity/reminders/${id}`, headers: bearer(bob.sessionToken) }))
        .statusCode,
    ).toBe(404);

    // Alice's reminder is untouched.
    const stillThere = await app.inject({ method: "GET", url: "/identity/reminders", headers: bearer(alice.sessionToken) });
    expect(stillThere.json()).toHaveLength(1);
    expect(stillThere.json()[0].completedAt).toBeNull();
    await app.close();
  });

  it("orders outstanding reminders by soonest due, with undated ones last", async () => {
    const app = buildApp();
    const identity = await register(app);
    const add = (title: string, dueAt?: string) =>
      app.inject({ method: "POST", url: "/identity/reminders", headers: bearer(identity.sessionToken), payload: { title, dueAt } });

    await add("No date");
    await add("Later", "2027-01-01T00:00:00Z");
    await add("Sooner", "2026-09-01T00:00:00Z");

    const listed = await app.inject({ method: "GET", url: "/identity/reminders", headers: bearer(identity.sessionToken) });
    // Postgres sorts NULLs first on ASC by default; an undated reminder
    // must not outrank a genuinely urgent one.
    expect(listed.json().map((reminder: { title: string }) => reminder.title)).toEqual(["Sooner", "Later", "No date"]);
    await app.close();
  });
});
