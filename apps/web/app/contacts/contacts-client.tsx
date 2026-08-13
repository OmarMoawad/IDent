"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./contacts.module.css";
import type { Contact, ContactDetail } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function contactName(contact: Contact): string {
  return contact.displayName?.trim() || contact.address;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function ContactsClient() {
  const { auth, restoring } = useAuth();
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<ContactDetail | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadContacts = useCallback(
    async (nextQuery: string) => {
      if (!auth) return;
      const path = nextQuery ? `/identity/contacts?query=${encodeURIComponent(nextQuery)}` : "/identity/contacts";
      setContacts(await apiGet<Contact[]>(path, auth.sessionToken));
    },
    [auth],
  );

  useEffect(() => {
    if (restoring) return;
    if (!auth) {
      router.push("/login");
      return;
    }
    setLoading(true);
    loadContacts("")
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [auth, restoring, router, loadContacts]);

  async function rebuild() {
    if (!auth) return;
    setRebuilding(true);
    setError(null);
    setStatus(null);
    try {
      const result = await apiPost<{ contactCount: number; messagesScanned: number }>(
        "/identity/contacts/rebuild",
        {},
        auth.sessionToken,
      );
      // Keep whatever filter the user is looking at rather than silently
      // resetting them to the full list.
      await loadContacts(query);
      setStatus(`Rebuilt from ${pluralize(result.messagesScanned, "message")}: ${pluralize(result.contactCount, "contact")}.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRebuilding(false);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const next = draftQuery.trim();
    setQuery(next);
    try {
      await loadContacts(next);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function clearSearch() {
    setDraftQuery("");
    setQuery("");
    try {
      await loadContacts("");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function openContact(contact: Contact) {
    if (!auth) return;
    setError(null);
    try {
      setSelected(await apiGet<ContactDetail>(`/identity/contacts/${contact.id}`, auth.sessionToken));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (restoring) return <main className={styles.shell}>Restoring your session…</main>;
  if (!auth) return <main className={styles.shell}>Redirecting to sign in…</main>;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>IDent Communications Hub</span>
          <h1>Contacts</h1>
        </div>
        <nav aria-label="Primary">
          <Link href="/inbox">Inbox</Link>
          <Link href="/calendar">Calendar</Link>
          <Link href="/assistant">Assistant</Link>
          <Link href="/contacts">Contacts</Link>
          <Link href="/account">Account</Link>
        </nav>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {status && <p role="status" className={styles.status}>{status}</p>}

      <section className={styles.toolbar} aria-labelledby="contacts-heading">
        <div>
          <h2 id="contacts-heading">People across your connected sources</h2>
          <p>Built from your synced messages — one card per person.</p>
        </div>
        <button onClick={rebuild} disabled={rebuilding}>
          {rebuilding ? "Rebuilding…" : "Rebuild from messages"}
        </button>
      </section>

      <form role="search" className={styles.search} onSubmit={search}>
        <label htmlFor="contact-search">Search contacts</label>
        <div>
          <input
            id="contact-search"
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            maxLength={200}
          />
          <button type="submit">Search</button>
          {query && (
            <button type="button" onClick={clearSearch}>
              Clear search
            </button>
          )}
        </div>
      </form>

      {loading ? (
        <p>Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p>
          {query
            ? "No contacts match this search."
            : "No contacts yet. Sync a connected source from the inbox, then rebuild."}
        </p>
      ) : (
        <div className={styles.layout}>
          <section className={styles.cards} aria-label="Contacts">
            {contacts.map((contact) => (
              <button
                key={contact.id}
                className={styles.card}
                onClick={() => openContact(contact)}
                aria-pressed={selected?.id === contact.id}
              >
                <span className={styles.cardName}>{contactName(contact)}</span>
                {contact.displayName && <span className={styles.cardAddress}>{contact.address}</span>}
                <span className={styles.cardMeta}>
                  {pluralize(contact.messageCount, "message")} · last{" "}
                  <time dateTime={contact.lastSeenAt}>{new Date(contact.lastSeenAt).toLocaleDateString()}</time>
                </span>
              </button>
            ))}
          </section>

          <article className={styles.detail} aria-label="Contact detail">
            {selected ? (
              <>
                <h2>{contactName(selected)}</h2>
                <p className={styles.cardAddress}>{selected.address}</p>
                <p className={styles.cardMeta}>
                  {pluralize(selected.messageCount, "message")} · first seen{" "}
                  <time dateTime={selected.firstSeenAt}>{new Date(selected.firstSeenAt).toLocaleDateString()}</time>
                </p>
                <h3>Recent messages</h3>
                {selected.messages.length === 0 ? (
                  <p>No messages available for this contact.</p>
                ) : (
                  <ul className={styles.detailMessages}>
                    {selected.messages.map((message) => (
                      <li key={message.id} className={styles.detailMessage}>
                        <strong>{message.subject || "(No subject)"}</strong>
                        <span>
                          <time dateTime={message.occurredAt}>{new Date(message.occurredAt).toLocaleString()}</time>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p>Select a contact to see their details.</p>
            )}
          </article>
        </div>
      )}
    </main>
  );
}
