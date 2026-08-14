"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./calendar.module.css";

type CalendarEvent = {
  id: string;
  title: string | null;
  location: string | null;
  startsAt: string;
  isAllDay: boolean;
};
type Reminder = { id: string; title: string; notes: string | null; dueAt: string | null; completedAt: string | null };
type Source = { id: string; provider: string; status: string; providerAccountEmail: string | null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** An all-day event has no meaningful time, so don't invent one. */
function formatWhen(event: CalendarEvent): string {
  const date = new Date(event.startsAt);
  return event.isAllDay ? `${date.toLocaleDateString()} (all day)` : date.toLocaleString();
}

export function CalendarClient() {
  const { auth, restoring } = useAuth();
  const router = useRouter();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth) return;
    const [nextEvents, nextReminders, nextSources] = await Promise.all([
      apiGet<CalendarEvent[]>("/identity/calendar/events", auth.sessionToken),
      apiGet<Reminder[]>("/identity/reminders", auth.sessionToken),
      apiGet<Source[]>("/identity/connections", auth.sessionToken),
    ]);
    setEvents(nextEvents);
    setReminders(nextReminders);
    setSources(nextSources);
  }, [auth]);

  useEffect(() => {
    if (restoring) return;
    if (!auth) {
      router.push("/login");
      return;
    }
    load().catch((reason) => setError(errorMessage(reason)));
  }, [auth, restoring, router, load]);

  async function syncCalendar(sourceId: string) {
    if (!auth) return;
    setSyncing(true);
    setError(null);
    setStatus(null);
    try {
      const result = await apiPost<{ eventsUpserted: number }>(
        `/identity/connections/google/${sourceId}/calendar/sync`,
        {},
        auth.sessionToken,
      );
      await load();
      setStatus(`Calendar synced: ${result.eventsUpserted} events.`);
    } catch (reason) {
      // A grant predating the calendar scope surfaces here as an explicit
      // reconnect prompt rather than an opaque failure.
      setError(errorMessage(reason));
    } finally {
      setSyncing(false);
    }
  }

  async function addReminder(event: FormEvent) {
    event.preventDefault();
    if (!auth || !title.trim()) return;
    setError(null);
    try {
      await apiPost("/identity/reminders", { title: title.trim(), dueAt: dueAt || undefined }, auth.sessionToken);
      setTitle("");
      setDueAt("");
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function complete(reminder: Reminder) {
    if (!auth) return;
    try {
      await apiPost(`/identity/reminders/${reminder.id}/completion`, { completed: true }, auth.sessionToken);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function remove(reminder: Reminder) {
    if (!auth) return;
    try {
      await apiDelete(`/identity/reminders/${reminder.id}`, auth.sessionToken);
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (restoring) return <main className={styles.shell}>Restoring your session…</main>;
  if (!auth) return <main className={styles.shell}>Redirecting to sign in…</main>;

  const google = sources.filter((source) => source.provider === "gmail" && source.status === "connected");

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>IDent Communications Hub</span>
          <h1>Calendar</h1>
        </div>
        <nav aria-label="Primary">
          <Link href="/inbox">Inbox</Link>
          <Link href="/contacts">Contacts</Link>
          <Link href="/assistant">Assistant</Link>
          <Link href="/account">Account</Link>
        </nav>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {status && <p role="status" className={styles.status}>{status}</p>}

      <section className={styles.toolbar}>
        <div>
          <h2>Upcoming events</h2>
          <p>{events.length === 0 ? "No upcoming events. Sync Google Calendar to import them." : `${events.length} upcoming.`}</p>
        </div>
        {google.map((source) => (
          <button key={source.id} onClick={() => syncCalendar(source.id)} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync calendar"}
          </button>
        ))}
      </section>

      {events.length > 0 && (
        <section className={styles.layout} aria-label="Events">
          {events.map((event) => (
            <article key={event.id} className={styles.card}>
              <strong>{event.title || "(untitled)"}</strong>
              <span className={styles.meta}>{formatWhen(event)}</span>
              {event.location && <span className={styles.meta}>{event.location}</span>}
            </article>
          ))}
        </section>
      )}

      <form className={styles.search} onSubmit={addReminder}>
        <label htmlFor="reminder-title">Add a reminder</label>
        <div>
          <input
            id="reminder-title"
            type="text"
            value={title}
            maxLength={200}
            placeholder="Renew passport"
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            aria-label="Due date"
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
          <button type="submit" disabled={!title.trim()}>Add</button>
        </div>
      </form>

      <section className={styles.layout} aria-label="Reminders">
        {reminders.length === 0 ? (
          <p>No outstanding reminders.</p>
        ) : (
          reminders.map((reminder) => (
            <article key={reminder.id} className={styles.card}>
              <strong>{reminder.title}</strong>
              <span className={styles.meta}>
                {reminder.dueAt ? `Due ${new Date(reminder.dueAt).toLocaleString()}` : "No due date"}
              </span>
              <span>
                <button onClick={() => complete(reminder)}>Complete</button>{" "}
                <button onClick={() => remove(reminder)}>Delete</button>
              </span>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
