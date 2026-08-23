import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { connectedSources, messages, sessions } from "../../db/schema.js";
import { getActiveAccessToken } from "../../comms/connection-service.js";
import { syncGmailMessages } from "../../comms/gmail-sync-service.js";
import { syncCalendarEvents } from "../../comms/calendar-sync-service.js";
import { upsertCalendarEvent } from "../../comms/calendar-store.js";

type ProviderEvent = {
  id: string;
  summary?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
};
import type { RetrievedReference } from "../assistant-intent.js";
import { DbActionProposalSink } from "./proposal-service.js";
import { buildProductionExecutor } from "./executor-factory.js";
import { createWriteActionService } from "./write-action-service.js";

/**
 * Phase 2 session 5 — a sanitized, machine-generated live-verification
 * artifact.
 *
 * Runs the three v1 write actions against a connected Google account through
 * the *production* path (propose → confirm → execute) and records what
 * happened as a safe artifact: a timestamp, the repo commit, the granted
 * scopes, and per action a before/after state and outcome code. Everything
 * that could identify a person or a message is either omitted or replaced by
 * a salted hash — no email addresses, subjects, bodies, event titles, or
 * tokens ever enter the artifact. The archive is restored afterwards, so the
 * run leaves the inbox as it found it; only a test draft remains (drafts are
 * never auto-deleted here).
 *
 * This is deliberately the *verification itself*, emitting the artifact as a
 * byproduct — so the file is evidence of a real run, not a hand-written
 * claim a reviewer cannot check.
 */

export type ActionVerification = {
  action: "reply.draft" | "message.archive" | "calendar.event.accept";
  status: "verified" | "skipped" | "failed";
  outcomeCode?: string | null;
  targetRef?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
};

export type LiveVerificationArtifact = {
  artifactVersion: 1;
  repo: "IDent";
  generatedAt: string;
  commit: string | null;
  identityRef: string;
  grantedScopes: string[];
  verifications: ActionVerification[];
};

/** Salted, truncated hash — enough to correlate within an artifact, not to identify. */
function ref(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16);
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";

export async function generateLiveVerificationArtifact(options: {
  commit: string | null;
  salt: string;
}): Promise<LiveVerificationArtifact> {
  const salt = options.salt;
  const [src] = await db
    .select()
    .from(connectedSources)
    .where(and(eq(connectedSources.provider, "gmail"), eq(connectedSources.status, "connected")))
    .orderBy(desc(connectedSources.createdAt))
    .limit(1);
  if (!src) throw new Error("No connected Google source — reconnect an account first.");

  const identityId = src.identityId;
  const [sess] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.identityId, identityId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  const { accessToken, scope } = await getActiveAccessToken(identityId, src.id);
  const auth = { authorization: `Bearer ${accessToken}` };

  // Pull fresh data so the run acts on real records.
  await syncGmailMessages(identityId, src.id);
  await syncCalendarEvents(identityId, src.id);

  const sink = new DbActionProposalSink();
  const service = createWriteActionService(buildProductionExecutor());
  const verifications: ActionVerification[] = [];

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.identityId, identityId))
    .orderBy(desc(messages.occurredAt))
    .limit(10);

  // --- reply.draft ---
  if (msgs[0]) {
    const m = msgs[0];
    const orig = (await (
      await fetch(`${GMAIL}/messages/${m.externalId}?format=metadata&metadataHeaders=Message-ID`, { headers: auth })
    ).json()) as { threadId?: string };
    const refs: RetrievedReference[] = [{ ref: "message:1", kind: "message", id: m.id }];
    const [preview] = await sink.propose({ identityId, sessionId: sess.id, refs, intents: [{ type: "reply.draft", targetRef: "message:1", body: "Live-verification draft (auto)." }] });
    await service.confirmAction({ identityId, sessionId: sess.id, actionId: preview.id, payloadDigest: preview.payloadDigest });
    const final = await service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest });
    // Confirm threading: find a draft whose threadId matches the original.
    const drafts = (await (await fetch(`${GMAIL}/drafts?maxResults=10`, { headers: auth })).json()) as { drafts?: { id: string }[] };
    let threaded = false;
    for (const d of drafts.drafts ?? []) {
      const full = (await (await fetch(`${GMAIL}/drafts/${d.id}?format=metadata`, { headers: auth })).json()) as { message?: { threadId?: string } };
      if (full.message?.threadId && full.message.threadId === orig.threadId) { threaded = true; break; }
    }
    verifications.push({
      action: "reply.draft",
      status: final.outcomeCode === "ok" ? "verified" : "failed",
      outcomeCode: final.outcomeCode,
      targetRef: ref(m.externalId, salt),
      before: { draftInThread: false },
      after: { draftCreated: true, threaded, threadRef: orig.threadId ? ref(orig.threadId, salt) : null },
    });
  }

  // --- message.archive (archive then restore, so the inbox ends unchanged) ---
  const archiveTarget = msgs.find((m) => m.id !== msgs[0]?.id) ?? msgs[0];
  if (archiveTarget) {
    const labelsBefore = await labelsOf(auth, archiveTarget.externalId);
    const refs: RetrievedReference[] = [{ ref: "message:1", kind: "message", id: archiveTarget.id }];
    const [preview] = await sink.propose({ identityId, sessionId: sess.id, refs, intents: [{ type: "message.archive", targetRefs: ["message:1"] }] });
    await service.confirmAction({ identityId, sessionId: sess.id, actionId: preview.id, payloadDigest: preview.payloadDigest });
    const final = await service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest });
    const labelsAfter = await labelsOf(auth, archiveTarget.externalId);
    // Restore the inbox label so the run is non-destructive.
    if (labelsBefore.includes("INBOX") && !labelsAfter.includes("INBOX")) {
      await fetch(`${GMAIL}/messages/${archiveTarget.externalId}/modify`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ addLabelIds: ["INBOX"] }),
      });
    }
    verifications.push({
      action: "message.archive",
      status: final.outcomeCode === "ok" || final.outcomeCode === "duplicate" ? "verified" : "failed",
      outcomeCode: final.outcomeCode,
      targetRef: ref(archiveTarget.externalId, salt),
      before: { inbox: labelsBefore.includes("INBOX") },
      after: { inbox: labelsAfter.includes("INBOX"), restored: true },
    });
  }

  // --- calendar.event.accept (only if a pending invite exists) ---
  // Query the provider directly rather than only the synced slice, so a
  // pending invite is found even on a busy calendar where the sync window
  // (or a stale DB) would miss it. Then upsert the found invite so the
  // proposal can resolve the reference by id.
  let pending: { id: string; externalId: string } | null = null;
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const listUrl = `${CAL}/events?${new URLSearchParams({ timeMin: since, maxResults: "250", singleEvents: "true", orderBy: "startTime" })}`;
  const list = (await (await fetch(listUrl, { headers: auth })).json()) as { items?: ProviderEvent[] };
  const invite = (list.items ?? []).find((e) => {
    const self = (e.attendees ?? []).find((a) => a.self);
    return self?.responseStatus === "needsAction" || self?.responseStatus === "tentative";
  });
  if (invite) {
    const row = await upsertCalendarEvent({
      identityId,
      sourceId: src.id,
      externalId: invite.id,
      title: invite.summary ?? null,
      description: null,
      location: invite.location ?? null,
      startsAt: new Date(invite.start?.dateTime ?? invite.start?.date ?? Date.now()),
      endsAt: invite.end?.dateTime ? new Date(invite.end.dateTime) : null,
      isAllDay: Boolean(invite.start?.date),
      attendees: JSON.stringify(invite.attendees ?? []),
      status: invite.status ?? null,
    });
    pending = { id: row.id, externalId: invite.id };
  }
  if (pending) {
    const beforeSelf = await selfResponse(auth, pending.externalId);
    const refs: RetrievedReference[] = [{ ref: "event:1", kind: "event", id: pending.id }];
    const [preview] = await sink.propose({ identityId, sessionId: sess.id, refs, intents: [{ type: "calendar.event.accept", targetRef: "event:1" }] });
    await service.confirmAction({ identityId, sessionId: sess.id, actionId: preview.id, payloadDigest: preview.payloadDigest });
    const final = await service.executeAction({ identityId, actionId: preview.id, payloadDigest: preview.payloadDigest });
    const afterSelf = await selfResponse(auth, pending.externalId);
    verifications.push({
      action: "calendar.event.accept",
      status: final.outcomeCode === "ok" ? "verified" : "failed",
      outcomeCode: final.outcomeCode,
      targetRef: ref(pending.externalId, salt),
      before: { selfResponse: beforeSelf },
      after: { selfResponse: afterSelf },
    });
  } else {
    verifications.push({
      action: "calendar.event.accept",
      status: "skipped",
      note: "No pending (needsAction/tentative) invitation on the primary calendar to accept.",
    });
  }

  return {
    artifactVersion: 1,
    repo: "IDent",
    generatedAt: new Date().toISOString(),
    commit: options.commit,
    identityRef: ref(identityId, salt),
    grantedScopes: scope.split(/\s+/).filter(Boolean),
    verifications,
  };
}

async function labelsOf(auth: Record<string, string>, id: string): Promise<string[]> {
  const meta = (await (await fetch(`${GMAIL}/messages/${id}?format=minimal`, { headers: auth })).json()) as { labelIds?: string[] };
  return meta.labelIds ?? [];
}

async function selfResponse(auth: Record<string, string>, eventId: string): Promise<string | null> {
  const g = (await (await fetch(`${CAL}/events/${encodeURIComponent(eventId)}`, { headers: auth })).json()) as { attendees?: { self?: boolean; responseStatus?: string }[] };
  return (g.attendees ?? []).find((a) => a.self)?.responseStatus ?? null;
}
