"use client";

import { useState } from "react";
import { apiPost } from "../../lib/api";
import styles from "./assistant.module.css";

/**
 * Phase 2 session 5 — the confirmation card for a proposed write action.
 *
 * It renders the *server-built* preview (recipient and body for a draft, a
 * batch count for archive, the event for an acceptance) and the exact effect,
 * then requires an explicit Confirm and a separate Execute. It echoes the
 * server's payload digest back on confirm — model prose is never the thing
 * approved — and shows every terminal and ambiguous state plainly, never
 * implying success. A failure caused by a missing write grant prompts a
 * reconnect rather than a retry.
 */

export type ActionSummary =
  | { kind: "reply.draft"; to: string; subject: string; body: string }
  | { kind: "message.archive"; count: number }
  | { kind: "calendar.event.accept"; title?: string };

export type PendingAction = {
  id: string;
  actionType: string;
  payloadDigest: string;
  expiresAt: string;
  status?: string;
  outcomeCode?: string | null;
  summary: ActionSummary;
};

type View = {
  status: string;
  outcomeCode?: string | null;
};

function label(status: string): string {
  const map: Record<string, string> = {
    pending: "Awaiting your confirmation",
    approved: "Approved — ready to run",
    executing: "Running…",
    succeeded: "Done",
    failed: "Failed",
    outcome_unknown: "Outcome unknown — check before retrying",
    expired: "Expired",
    cancelled: "Cancelled",
  };
  return map[status] ?? status;
}

const TERMINAL = new Set(["succeeded", "failed", "outcome_unknown", "expired", "cancelled"]);

export function ActionCard({ action, token }: { action: PendingAction; token: string }) {
  const [view, setView] = useState<View>({ status: action.status ?? "pending" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await apiPost<View>(`/identity/assistant/actions/${action.id}/${path}`, {
        payloadDigest: action.payloadDigest,
      }, token);
      setView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const ineligible = view.status === "failed" && (view.outcomeCode ?? "").startsWith("ineligible");

  return (
    <article className={styles.card} aria-label="Proposed action">
      <ActionDescription summary={action.summary} />
      <p className={styles.meta} data-status={view.status}>{label(view.status)}</p>
      {view.status === "succeeded" && view.outcomeCode === "duplicate" && (
        <p className={styles.meta}>This was already done — nothing changed.</p>
      )}
      {ineligible && (
        <p className={styles.meta}>
          This connection is not authorised to make changes. Reconnect the account and grant
          the requested access, then propose it again.
        </p>
      )}

      {!TERMINAL.has(view.status) && (
        <div className={styles.actions}>
          {view.status === "pending" && (
            <button type="button" disabled={busy} onClick={() => call("confirm")}>
              {busy ? "Confirming…" : "Confirm"}
            </button>
          )}
          {view.status === "approved" && (
            <button type="button" disabled={busy} onClick={() => call("execute")}>
              {busy ? "Running…" : "Run it"}
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => call("cancel")}>
            Cancel
          </button>
        </div>
      )}

      {error && <p role="alert" className={styles.error}>{error}</p>}
    </article>
  );
}

function ActionDescription({ summary }: { summary: ActionSummary }) {
  if (summary.kind === "reply.draft") {
    return (
      <div>
        <h3>Create a reply draft</h3>
        <p className={styles.meta}>To: {summary.to}</p>
        <p className={styles.meta}>Subject: {summary.subject}</p>
        <pre>{summary.body}</pre>
        <p className={styles.meta}>A draft only — nothing is sent.</p>
      </div>
    );
  }
  if (summary.kind === "message.archive") {
    return (
      <div>
        <h3>Archive {summary.count} message{summary.count === 1 ? "" : "s"}</h3>
        <p className={styles.meta}>Removes them from your inbox. Nothing is deleted.</p>
      </div>
    );
  }
  return (
    <div>
      <h3>Accept a calendar invitation</h3>
      {summary.title && <p className={styles.meta}>{summary.title}</p>}
    </div>
  );
}
