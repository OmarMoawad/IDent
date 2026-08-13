import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import { syncCalendarEvents } from "./calendar-sync-service.js";
import {
  deleteReminder,
  findCalendarEventsByIdentity,
  findRemindersByIdentity,
  insertReminder,
  setReminderCompletion,
  type CalendarEvent,
  type Reminder,
} from "./calendar-store.js";
import {
  ConnectedSourceNotConnectedError,
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
} from "./gmail-service.js";

const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 2_000;

async function authenticatedIdentity(request: FastifyRequest) {
  const token = extractBearerToken(request.headers.authorization);
  return token ? validateSession(token) : null;
}

/** identityId and sourceId stay server-side; the client has no use for either. */
function publicEvent(event: CalendarEvent) {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    isAllDay: event.isAllDay,
    attendees: event.attendees,
    status: event.status,
  };
}

function publicReminder(reminder: Reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    notes: reminder.notes,
    dueAt: reminder.dueAt,
    completedAt: reminder.completedAt,
    createdAt: reminder.createdAt,
  };
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function registerCalendarRoutes(app: FastifyInstance): void {
  app.get("/identity/calendar/events", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    // Defaults to upcoming, which is what a calendar view wants; an
    // explicit `from` can look further back.
    const query = request.query as { from?: string; to?: string };
    const events = await findCalendarEventsByIdentity(identity.identityId, {
      from: parseDate(query.from) ?? new Date(),
      to: parseDate(query.to) ?? undefined,
    });
    return events.map(publicEvent);
  });

  app.post<{ Params: { sourceId: string } }>(
    "/identity/connections/google/:sourceId/calendar/sync",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

      try {
        const result = await syncCalendarEvents(identity.identityId, request.params.sourceId);
        if (result.needsReconnect) {
          // 409, not 403: the grant is valid, it just predates the
          // calendar scope. The client's remedy is to reconnect.
          return reply.code(409).send({
            error: "This connection predates calendar access. Reconnect Google to grant it.",
            needsReconnect: true,
          });
        }
        return result;
      } catch (error) {
        if (error instanceof ConnectedSourceNotFoundError || error instanceof ConnectedSourceOwnershipError) {
          // Ownership failures are deliberately indistinguishable from
          // missing, same as the message detail route.
          return reply.code(404).send({ error: "Connected source not found." });
        }
        if (error instanceof ConnectedSourceNotConnectedError) {
          return reply.code(409).send({ error: "This source is not connected." });
        }
        throw error;
      }
    },
  );

  app.get("/identity/reminders", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    const includeCompleted = (request.query as { includeCompleted?: string }).includeCompleted === "true";
    return (await findRemindersByIdentity(identity.identityId, { includeCompleted })).map(publicReminder);
  });

  app.post<{ Body: { title?: unknown; notes?: unknown; dueAt?: unknown } }>(
    "/identity/reminders",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

      const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
      if (!title) return reply.code(400).send({ error: "A reminder needs a title." });
      if (title.length > MAX_TITLE_LENGTH) {
        return reply.code(400).send({ error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` });
      }

      const notes = typeof request.body?.notes === "string" ? request.body.notes.trim() : "";
      if (notes.length > MAX_NOTES_LENGTH) {
        return reply.code(400).send({ error: `Notes must be ${MAX_NOTES_LENGTH} characters or fewer.` });
      }

      const reminder = await insertReminder({
        identityId: identity.identityId,
        title,
        notes: notes || null,
        dueAt: parseDate(request.body?.dueAt),
      });
      return reply.code(201).send(publicReminder(reminder));
    },
  );

  app.post<{ Params: { reminderId: string }; Body: { completed?: unknown } }>(
    "/identity/reminders/:reminderId/completion",
    async (request, reply) => {
      const identity = await authenticatedIdentity(request);
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

      const completed = request.body?.completed !== false;
      const reminder = await setReminderCompletion(request.params.reminderId, identity.identityId, completed);
      if (!reminder) return reply.code(404).send({ error: "Reminder not found." });
      return publicReminder(reminder);
    },
  );

  app.delete<{ Params: { reminderId: string } }>("/identity/reminders/:reminderId", async (request, reply) => {
    const identity = await authenticatedIdentity(request);
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });
    if (!(await deleteReminder(request.params.reminderId, identity.identityId))) {
      return reply.code(404).send({ error: "Reminder not found." });
    }
    return reply.code(204).send();
  });
}
