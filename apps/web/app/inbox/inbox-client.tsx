"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./inbox.module.css";
import type { InboxMessage, InboxSource } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function participantSummary(raw: string | null): string {
  if (!raw) return "Unknown sender";
  try {
    const participants = JSON.parse(raw) as Array<{ name?: string; address: string }>;
    return participants.map((participant) => participant.name || participant.address).join(", ") || "Unknown sender";
  } catch {
    return "Unknown sender";
  }
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

  const loadMessages = useCallback(async (nextQuery = query) => {
    if (!auth) return;
    const path = nextQuery ? `/identity/messages?query=${encodeURIComponent(nextQuery)}` : "/identity/messages";
    const result = await apiGet<InboxMessage[]>(path, auth.sessionToken);
    setMessages(result);
  }, [auth, query]);

  useEffect(() => {
    if (restoring) return;
    if (!auth) {
      router.push("/login");
      return;
    }
    setLoading(true);
    Promise.all([apiGet<InboxSource[]>("/identity/connections", auth.sessionToken), apiGet<InboxMessage[]>("/identity/messages", auth.sessionToken)])
      .then(([nextSources, nextMessages]) => {
        setSources(nextSources);
        setMessages(nextMessages);
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
      setStatus(`Sync complete: ${result.messagesSeen} seen, ${result.messagesUpserted} saved.`);
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
        <nav aria-label="Primary"><Link href="/inbox">Inbox</Link><Link href="/account">Account</Link></nav>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {status && <p role="status" className={styles.status}>{status}</p>}

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
                <span className={styles.messageTop}><strong>{message.subject || "(No subject)"}</strong>{!message.isRead && <span className={styles.unread}>Unread</span>}</span>
                <span>{participantSummary(message.participants)}</span><span>{message.snippet || "No preview available"}</span>
                <span className={styles.messageMeta}>{message.source?.providerAccountEmail || message.source?.provider || "Unknown source"} · <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleString()}</time></span>
              </button>
            ))}
          </section>
          <article className={styles.reader} aria-label="Message reader">
            {selected ? <><h2>{selected.subject || "(No subject)"}</h2><p>{participantSummary(selected.participants)}</p><pre>{selected.body || selected.snippet || "No message body available."}</pre></> : <p>Select a message to read it.</p>}
          </article>
        </div>
      )}
    </main>
  );
}
