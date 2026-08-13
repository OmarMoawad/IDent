"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { parseMessageParticipants, participantLabel } from "@ident/shared";
import { apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./inbox.module.css";
import type { InboxMessage, InboxSource } from "./types";

type Priority = {
  messageId: string;
  level: "high" | "normal" | "low";
  reason: string;
  assignedBy: "assistant" | "user" | "rule";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Session 16 parsed this column as a flat array while the Gmail sync
 * writes an `{from, to}` envelope, so `.map` threw on every real synced
 * message and the catch quietly turned all of them into "Unknown sender".
 * Both sides now go through one shared parser — see
 * parseMessageParticipants in @ident/shared for why that lives there.
 */
function participantSummary(raw: string | null): string {
  const { from, to } = parseMessageParticipants(raw);
  const people = from.length > 0 ? from : to;
  return people.map(participantLabel).join(", ") || "Unknown sender";
}

export function InboxClient() {
  const { auth, restoring } = useAuth();
  const router = useRouter();
  const [sources, setSources] = useState<InboxSource[]>([]);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [selected, setSelected] = useState<InboxMessage | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [workingSource, setWorkingSource] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<Record<string, Priority>>({});
  const [kind, setKind] = useState<"" | "message" | "notification">("");
  const [endpoint, setEndpoint] = useState<{ token: string; header: string; path: string; notice: string } | null>(null);
  const [endpointStatus, setEndpointStatus] = useState<{ configured: boolean; lastError: string | null } | null>(null);

  const loadMessages = useCallback(async (nextQuery = query, nextKind = kind) => {
    if (!auth) return;
    const params = new URLSearchParams();
    if (nextQuery) params.set("query", nextQuery);
    // No kind param means both — the inbox is unified by default and the
    // segments are a view, not a filter that hides anything permanently.
    if (nextKind) params.set("kind", nextKind);
    const suffix = params.toString();
    const result = await apiGet<InboxMessage[]>(`/identity/messages${suffix ? `?${suffix}` : ""}`, auth.sessionToken);
    setMessages(result);
  }, [auth, query, kind]);

  async function showKind(next: "" | "message" | "notification") {
    setKind(next);
    setError(null);
    try {
      await loadMessages(query, next);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  /**
   * Minting returns the plaintext exactly once — only its hash is stored —
   * so the UI has to say that outright rather than implying it can be
   * looked up again later.
   */
  async function mintEndpoint() {
    if (!auth) return;
    setError(null);
    try {
      setEndpoint(
        await apiPost<{ token: string; header: string; path: string; notice: string }>(
          "/identity/notifications/endpoint",
          {},
          auth.sessionToken,
        ),
      );
      setEndpointStatus({ configured: true, lastError: null });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  useEffect(() => {
    if (restoring) return;
    if (!auth) {
      router.push("/login");
      return;
    }
    setLoading(true);
    Promise.all([
      apiGet<InboxSource[]>("/identity/connections", auth.sessionToken),
      apiGet<InboxMessage[]>("/identity/messages", auth.sessionToken),
      apiGet<Priority[]>("/identity/priorities", auth.sessionToken),
      apiGet<{ configured: boolean; lastError: string | null }>("/identity/notifications/endpoint", auth.sessionToken),
    ])
      .then(([nextSources, nextMessages, nextPriorities, nextEndpoint]) => {
        setSources(nextSources);
        setMessages(nextMessages);
        setPriorities(Object.fromEntries(nextPriorities.map((p) => [p.messageId, p])));
        setEndpointStatus(nextEndpoint);
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [auth, restoring, router]);

  async function connectGmail() {
    if (!auth) return;
    setError(null);
    try {
      const { authorizationUrl } = await apiPost<{ authorizationUrl: string }>("/identity/connections/gmail/start", {}, auth.sessionToken);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function sync(source: InboxSource) {
    if (!auth) return;
    setWorkingSource(source.id);
    setError(null);
    setStatus(null);
    try {
      const result = await apiPost<{ messagesSeen: number; messagesUpserted: number }>(`/identity/connections/gmail/${source.id}/sync`, {}, auth.sessionToken);
      await loadMessages();
      // Contacts are derived from messages, so new mail can mean new
      // people. A failure here must not fail the sync — the messages are
      // already saved — but it must not be hidden either: contacts would
      // be silently stale while the UI claimed everything succeeded.
      let contactsRefreshed = true;
      try {
        await apiPost("/identity/contacts/rebuild", {}, auth.sessionToken);
      } catch {
        contactsRefreshed = false;
      }
      const synced = `Sync complete: ${result.messagesSeen} seen, ${result.messagesUpserted} saved.`;
      setStatus(contactsRefreshed ? synced : `${synced} Contacts could not be refreshed — open Contacts and rebuild.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorkingSource(null);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setQuery(draftQuery.trim());
    try {
      await loadMessages(draftQuery.trim());
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function clearSearch() {
    setDraftQuery("");
    setQuery("");
    try {
      await loadMessages("");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function reloadPriorities() {
    if (!auth) return;
    const next = await apiGet<Priority[]>("/identity/priorities", auth.sessionToken);
    setPriorities(Object.fromEntries(next.map((p) => [p.messageId, p])));
  }

  async function classify() {
    if (!auth) return;
    setError(null);
    try {
      const result = await apiPost<{ classified: number }>("/identity/priorities/classify", {}, auth.sessionToken);
      await reloadPriorities();
      setStatus(`Reviewed ${result.classified} messages. Nothing was hidden — priorities only re-order what you see.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  /** The per-message half of the override the roadmap requires. */
  async function setPriority(messageId: string, level: Priority["level"]) {
    if (!auth) return;
    setError(null);
    try {
      await apiPost(`/identity/priorities/${messageId}`, { level }, auth.sessionToken);
      await reloadPriorities();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  /** The rule half — "stop deprioritizing this person", not just this mail. */
  async function alwaysPrioritize(message: InboxMessage) {
    if (!auth) return;
    setError(null);
    try {
      const { from } = JSON.parse(message.participants ?? '{"from":[]}') as { from?: Array<{ address: string }> };
      const address = from?.[0]?.address;
      if (!address) return;
      await apiPost("/identity/priority-rules", { matchType: "contact", matchValue: address, level: "high" }, auth.sessionToken);
      await apiPost("/identity/priorities/classify", {}, auth.sessionToken);
      await reloadPriorities();
      setStatus(`Mail from ${address} will be marked high from now on.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function openMessage(message: InboxMessage) {
    if (!auth) return;
    setError(null);
    try {
      setSelected(await apiGet<InboxMessage>(`/identity/messages/${message.id}`, auth.sessionToken));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (restoring) return <main className={styles.shell}>Restoring your session…</main>;
  if (!auth) return <main className={styles.shell}>Redirecting to sign in…</main>;

  const connected = sources.filter((source) => source.provider === "gmail" && source.status === "connected");

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div><span className={styles.eyebrow}>IDent Communications Hub</span><h1>Inbox</h1></div>
        <nav aria-label="Primary"><Link href="/inbox">Inbox</Link><Link href="/contacts">Contacts</Link><Link href="/calendar">Calendar</Link><Link href="/assistant">Assistant</Link><Link href="/account">Account</Link></nav>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {status && <p role="status" className={styles.status}>{status}</p>}

      <section className={styles.sources} aria-labelledby="notifications-heading">
        <div>
          <h2 id="notifications-heading">Notifications</h2>
          <p>Notifications from connected services arrive in this same inbox.</p>
          {endpoint && (
            <>
              <p>
                Send them to <code>{endpoint.path}</code> with header{" "}
                <code>
                  {endpoint.header}: {endpoint.token}
                </code>
              </p>
              {/* Stated outright, because it is true and irreversible. */}
              <p role="status">{endpoint.notice}</p>
            </>
          )}
          {endpointStatus?.lastError && (
            // The ingest endpoint tells senders nothing, so this is the only
            // place a misconfigured sender becomes visible.
            <p role="alert">Last delivery rejected: {endpointStatus.lastError}</p>
          )}
        </div>
        <button onClick={mintEndpoint}>
          {endpointStatus?.configured ? "Regenerate ingest token" : "Create ingest token"}
        </button>
      </section>

      <section className={styles.sources} aria-label="Filter by kind">
        <div role="group" aria-label="Show">
          <button onClick={() => showKind("")} aria-pressed={kind === ""}>All</button>{" "}
          <button onClick={() => showKind("message")} aria-pressed={kind === "message"}>Messages</button>{" "}
          <button onClick={() => showKind("notification")} aria-pressed={kind === "notification"}>Notifications</button>
        </div>
      </section>

      <section className={styles.sources} aria-labelledby="priority-heading">
        <div>
          <h2 id="priority-heading">Priorities</h2>
          <p>Labels only. Nothing is hidden or deleted, and you can override any call.</p>
        </div>
        <button onClick={classify}>Review priorities</button>
      </section>

      <section className={styles.sources} aria-labelledby="sources-heading">
        <div><h2 id="sources-heading">Connected sources</h2>{connected.map((source) => <p key={source.id}>{source.providerAccountEmail ?? "Gmail"} · {source.status}</p>)}</div>
        {connected.length === 0 ? <button onClick={connectGmail}>Connect Gmail</button> : connected.map((source) => <button key={source.id} onClick={() => sync(source)} disabled={workingSource === source.id}>{workingSource === source.id ? "Syncing…" : "Sync now"}</button>)}
      </section>

      {connected.length === 0 && <p>Connect Gmail to bring messages into IDent.</p>}
      <form role="search" className={styles.search} onSubmit={search}>
        <label htmlFor="inbox-search">Search messages</label>
        <div><input id="inbox-search" type="search" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} maxLength={200} /><button type="submit">Search</button>{query && <button type="button" onClick={clearSearch}>Clear search</button>}</div>
      </form>

      {loading ? <p>Loading inbox…</p> : connected.length > 0 && messages.length === 0 ? <p>{query ? "No messages match this search." : "No messages yet. Sync Gmail to import recent mail."}</p> : (
        <div className={styles.inbox}>
          <section className={styles.list} aria-label="Messages">
            {messages.map((message) => (
              <button key={message.id} className={styles.message} onClick={() => openMessage(message)} aria-pressed={selected?.id === message.id}>
                <span className={styles.messageTop}><strong>{message.subject || "(No subject)"}</strong>{message.kind === "notification" && <span className={styles.unread}>Notification</span>}{!message.isRead && message.kind !== "notification" && <span className={styles.unread}>Unread</span>}</span>
                <span>{participantSummary(message.participants)}</span><span>{message.snippet || "No preview available"}</span>
                <span className={styles.messageMeta}>{message.source?.providerAccountEmail || message.source?.provider || "Unknown source"} · <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleString()}</time></span>
                {priorities[message.id] && (
                  // Shown inline, never used to hide the row: the reason is
                  // the whole point of a negotiated filter.
                  <span className={styles.messageMeta}>
                    Priority: {priorities[message.id].level} — {priorities[message.id].reason}
                  </span>
                )}
              </button>
            ))}
          </section>
          <article className={styles.reader} aria-label="Message reader">
            {selected ? (
              <>
                <h2>{selected.subject || "(No subject)"}</h2>
                <p>{participantSummary(selected.participants)}</p>
                {priorities[selected.id] && (
                  <p className={styles.messageMeta}>
                    Priority: <strong>{priorities[selected.id].level}</strong> ({priorities[selected.id].assignedBy}) —{" "}
                    {priorities[selected.id].reason}
                  </p>
                )}
                <p>
                  {/* Both overrides the roadmap requires: this one call, or
                      the rule behind it. */}
                  <button onClick={() => setPriority(selected.id, "high")}>Mark high</button>{" "}
                  <button onClick={() => setPriority(selected.id, "low")}>Mark low</button>{" "}
                  <button onClick={() => alwaysPrioritize(selected)}>Always prioritize this sender</button>
                </p>
                {selected.actionUrl && (
                  // The URL is validated to http/https at ingest, so this
                  // link can never be a javascript: payload.
                  <p>
                    <a href={selected.actionUrl} target="_blank" rel="noopener noreferrer">
                      Open in {participantSummary(selected.participants)}
                    </a>
                  </p>
                )}
                <pre>{selected.body || selected.snippet || "No message body available."}</pre>
              </>
            ) : (
              <p>Select a message to read it.</p>
            )}
          </article>
        </div>
      )}
    </main>
  );
}
