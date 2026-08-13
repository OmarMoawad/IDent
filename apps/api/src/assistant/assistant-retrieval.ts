import { parseMessageParticipants, participantLabel } from "@ident/shared";
import { findMessagesByIdentity } from "../comms/store.js";
import { findCalendarEventsByIdentity, findRemindersByIdentity } from "../comms/calendar-store.js";
import { findContactsByIdentity } from "../comms/contacts-store.js";
import {
  MAX_CONTEXT_CONTACTS,
  MAX_CONTEXT_EVENTS,
  MAX_CONTEXT_MESSAGES,
  MAX_ITEM_CHARS,
} from "./assistant-config.js";

/**
 * Builds the bounded context the assistant is allowed to see.
 *
 * This module *is* the privacy boundary. The decision recorded with Omar
 * (2026-08-13) was "send only what's needed, and disclose it" — so the
 * assistant never receives the mailbox. It receives a handful of items
 * selected here, each truncated, with a hard ceiling on every category.
 * Anything this function does not return cannot reach the model.
 */

export type RetrievedContext = {
  text: string;
  /** What was actually sent, so the API can tell the user (and tests can assert). */
  counts: { messages: number; events: number; contacts: number; reminders: number };
};

/**
 * Words worth searching on. Drops the filler that would otherwise match
 * every message in the store and turn a targeted retrieval into a dump.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "up", "about", "into", "over", "after", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "what", "when", "who", "whom", "which", "how",
  "why", "where", "me", "my", "i", "you", "your", "it", "its", "this", "that", "these",
  "those", "there", "here", "can", "could", "should", "would", "will", "any", "all", "did",
]);

export function extractSearchTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  // Deduplicate but keep order — earlier words in a question tend to carry
  // more of its intent.
  return [...new Set(terms)].slice(0, 6);
}

function truncate(value: string | null | undefined): string {
  if (!value) return "";
  const text = value.trim();
  return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS)}…[truncated]` : text;
}

function senderLabel(participants: string | null): string {
  const { from } = parseMessageParticipants(participants);
  return from.map(participantLabel).join(", ") || "unknown sender";
}

/**
 * Ranks messages by how many of the question's terms they contain, so a
 * targeted question pulls the messages it is actually about rather than
 * simply the most recent ones. Falls back to recency when the question has
 * no usable terms ("what's new?").
 */
async function retrieveMessages(identityId: string, terms: string[]) {
  const candidates = await findMessagesByIdentity(identityId, { limit: 100 });
  if (terms.length === 0) return candidates.slice(0, MAX_CONTEXT_MESSAGES);

  const scored = candidates.map((message) => {
    const haystack = [message.subject, message.snippet, message.body, message.participants]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return { message, score: terms.filter((term) => haystack.includes(term)).length };
  });

  const matches = scored.filter((entry) => entry.score > 0);
  // No keyword hits at all: fall back to recent mail rather than sending
  // nothing, so the assistant can still say "I looked and didn't find it".
  if (matches.length === 0) return candidates.slice(0, Math.min(5, MAX_CONTEXT_MESSAGES));

  return matches
    .sort((a, b) => b.score - a.score || b.message.occurredAt.getTime() - a.message.occurredAt.getTime())
    .slice(0, MAX_CONTEXT_MESSAGES)
    .map((entry) => entry.message);
}

export async function buildAssistantContext(identityId: string, question: string): Promise<RetrievedContext> {
  const terms = extractSearchTerms(question);

  const [messages, events, contacts, reminders] = await Promise.all([
    retrieveMessages(identityId, terms),
    findCalendarEventsByIdentity(identityId, { from: new Date(), limit: MAX_CONTEXT_EVENTS }),
    findContactsByIdentity(identityId, { limit: MAX_CONTEXT_CONTACTS }),
    findRemindersByIdentity(identityId),
  ]);

  const boundedReminders = reminders.slice(0, MAX_CONTEXT_EVENTS);
  const sections: string[] = [];

  if (messages.length > 0) {
    sections.push(
      "MESSAGES:\n" +
        messages
          .map((message, index) =>
            [
              `[message ${index + 1}]`,
              `from: ${senderLabel(message.participants)}`,
              `date: ${message.occurredAt.toISOString()}`,
              `subject: ${truncate(message.subject) || "(none)"}`,
              `body: ${truncate(message.body ?? message.snippet) || "(empty)"}`,
            ].join("\n"),
          )
          .join("\n\n"),
    );
  }

  if (events.length > 0) {
    sections.push(
      "CALENDAR EVENTS:\n" +
        events
          .map((event, index) =>
            [
              `[event ${index + 1}]`,
              `title: ${truncate(event.title) || "(untitled)"}`,
              `starts: ${event.startsAt.toISOString()}${event.isAllDay ? " (all day)" : ""}`,
              event.location ? `location: ${truncate(event.location)}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
    );
  }

  if (contacts.length > 0) {
    sections.push(
      "CONTACTS:\n" +
        contacts
          .map(
            (contact, index) =>
              `[contact ${index + 1}] ${contact.displayName ?? contact.address} <${contact.address}> — ${contact.messageCount} messages, last ${contact.lastSeenAt.toISOString()}`,
          )
          .join("\n"),
    );
  }

  if (boundedReminders.length > 0) {
    sections.push(
      "REMINDERS:\n" +
        boundedReminders
          .map(
            (reminder, index) =>
              `[reminder ${index + 1}] ${truncate(reminder.title)}${reminder.dueAt ? ` — due ${reminder.dueAt.toISOString()}` : " — no due date"}`,
          )
          .join("\n"),
    );
  }

  return {
    text: sections.length > 0 ? sections.join("\n\n") : "(no matching items found in this identity's data)",
    counts: {
      messages: messages.length,
      events: events.length,
      contacts: contacts.length,
      reminders: boundedReminders.length,
    },
  };
}
