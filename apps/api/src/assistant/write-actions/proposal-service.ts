import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseMessageParticipants } from "@ident/shared";
import { db } from "../../db/client.js";
import { calendarEvents, messages } from "../../db/schema.js";
import type { ActionIntent, RetrievedReference } from "../assistant-intent.js";
import { MAX_ARCHIVE_TARGETS } from "../assistant-intent.js";
import { canonicalize, digestCanonical, type CanonicalValue } from "./canonical-json.js";
import { createPendingAction } from "./store.js";
import { ACTION_SCHEMA_VERSION, ACTION_TTL_MS, type WriteActionType } from "./types.js";

/**
 * Phase 2 session 5 — where a model's constrained intent becomes a
 * server-owned, previewed, pending action.
 *
 * This is the boundary the whole design turns on. The model supplied only
 * an opaque `message:<n>` / `event:<n>` handle and, for a draft, some body
 * text. *Everything else* — the recipient, the provider ids, the reply
 * headers, the operation key, the RSVP value — is derived here from the
 * identity's own stored records, resolved against the exact retrieval slice
 * this request built. A handle that is not in that slice resolves to
 * nothing and is rejected. Nothing is executed: this only ever writes a
 * `pending` action awaiting a human's confirmation of the server-rendered
 * preview.
 */

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/** The display-safe view of a pending action — what a confirmation card renders. */
export type PendingActionPreview = {
  id: string;
  actionType: WriteActionType;
  payloadDigest: string;
  expiresAt: Date;
  summary:
    | { kind: "reply.draft"; to: string; subject: string; body: string }
    | { kind: "message.archive"; count: number }
    | { kind: "calendar.event.accept"; title: string };
};

export type ProposeInput = {
  identityId: string;
  sessionId: string;
  refs: RetrievedReference[];
  intents: ActionIntent[];
};

export interface ActionProposalSink {
  propose(input: ProposeInput): Promise<PendingActionPreview[]>;
}

/** Resolve one opaque handle against the slice, or reject it. */
function resolveRef(refs: RetrievedReference[], ref: string, kind: "message" | "event"): string {
  const match = refs.find((candidate) => candidate.ref === ref && candidate.kind === kind);
  if (!match) {
    throw new ProposalError(`Reference ${ref} is not in this request's retrieval slice`);
  }
  return match.id;
}

function subjectReply(subject: string | null): string {
  const base = (subject ?? "").trim();
  if (base.length === 0) return "Re:";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** The production sink: resolves against stores and persists a pending action. */
export class DbActionProposalSink implements ActionProposalSink {
  async propose(input: ProposeInput): Promise<PendingActionPreview[]> {
    const previews: PendingActionPreview[] = [];
    for (const intent of input.intents) {
      previews.push(await this.proposeOne(input, intent));
    }
    return previews;
  }

  private async proposeOne(input: ProposeInput, intent: ActionIntent): Promise<PendingActionPreview> {
    const operationKey = randomUUID();
    const expiresAt = new Date(Date.now() + ACTION_TTL_MS);

    if (intent.type === "reply.draft") {
      const messageId = resolveRef(input.refs, intent.targetRef, "message");
      const message = await this.loadMessage(input.identityId, messageId);
      // Sender-only in v1: the recipient is the message's own sender,
      // derived server-side — never anything the model supplied.
      const { from } = parseMessageParticipants(message.participants);
      const to = from[0]?.address;
      if (!to) throw new ProposalError("Cannot reply: the message has no sender address on file");

      const subject = subjectReply(message.subject);
      const payload = {
        type: "reply.draft",
        schemaVersion: ACTION_SCHEMA_VERSION,
        sourceId: message.sourceId,
        providerMessageId: message.externalId,
        to,
        subject,
        body: intent.body,
      } satisfies Record<string, CanonicalValue>;

      const preview = await this.persist(input, "reply.draft", payload, operationKey, expiresAt, {
        // Preconditions are what the server knew at proposal time, not a
        // provider fetch — proposal must not touch a provider.
        messageId,
      });
      return { ...preview, summary: { kind: "reply.draft", to, subject, body: intent.body } };
    }

    if (intent.type === "message.archive") {
      if (intent.targetRefs.length > MAX_ARCHIVE_TARGETS) {
        throw new ProposalError(`Archive accepts at most ${MAX_ARCHIVE_TARGETS} messages`);
      }
      const targets: { sourceId: string; providerMessageId: string }[] = [];
      for (const ref of intent.targetRefs) {
        const message = await this.loadMessage(input.identityId, resolveRef(input.refs, ref, "message"));
        targets.push({ sourceId: message.sourceId, providerMessageId: message.externalId });
      }
      const payload = {
        type: "message.archive",
        schemaVersion: ACTION_SCHEMA_VERSION,
        targets: targets.map((t) => ({ sourceId: t.sourceId, providerMessageId: t.providerMessageId })),
      } satisfies Record<string, CanonicalValue>;

      const preview = await this.persist(input, "message.archive", payload, operationKey, expiresAt, {
        expectedLabel: "INBOX",
      });
      return { ...preview, summary: { kind: "message.archive", count: targets.length } };
    }

    // calendar.event.accept
    const eventId = resolveRef(input.refs, intent.targetRef, "event");
    const event = await this.loadEvent(input.identityId, eventId);
    const payload = {
      type: "calendar.event.accept",
      schemaVersion: ACTION_SCHEMA_VERSION,
      sourceId: event.sourceId,
      providerEventId: event.externalId,
      response: "accepted",
    } satisfies Record<string, CanonicalValue>;

    const preview = await this.persist(input, "calendar.event.accept", payload, operationKey, expiresAt, {
      eventId,
    });
    return { ...preview, summary: { kind: "calendar.event.accept", title: event.title ?? "(untitled)" } };
  }

  private async persist(
    input: ProposeInput,
    actionType: WriteActionType,
    payload: Record<string, CanonicalValue>,
    operationKey: string,
    expiresAt: Date,
    preconditions: Record<string, CanonicalValue>,
  ): Promise<Omit<PendingActionPreview, "summary">> {
    const canonicalPayload = canonicalize(payload);
    const payloadDigest = digestCanonical(payload);
    const row = await createPendingAction({
      identityId: input.identityId,
      requestingSessionId: input.sessionId,
      actionType,
      schemaVersion: ACTION_SCHEMA_VERSION,
      canonicalPayload,
      payloadDigest,
      retrievalSlice: JSON.stringify(input.refs),
      preconditions: JSON.stringify(preconditions),
      operationKey,
      expiresAt,
    });
    return { id: row.id, actionType, payloadDigest, expiresAt };
  }

  private async loadMessage(identityId: string, id: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.identityId, identityId)));
    if (!row) throw new ProposalError("The referenced message is not owned by this identity");
    return row;
  }

  private async loadEvent(identityId: string, id: string) {
    const [row] = await db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.identityId, identityId)));
    if (!row) throw new ProposalError("The referenced event is not owned by this identity");
    return row;
  }
}
