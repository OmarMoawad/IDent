"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import styles from "./assistant.module.css";

type AssistantStatus = { available: boolean; provider: string; model: string };
type ContextSent = { messages: number; events: number; contacts: number; reminders: number };
type AskResult = { answer: string; refused: boolean; contextSent: ContextSent };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * The disclosure sentence. SECURITY.md commits to telling the user what
 * left the server, and an API field nobody renders is not a disclosure —
 * this is where that promise is actually kept.
 */
function describeContext(sent: ContextSent): string {
  const parts = [
    sent.messages && `${sent.messages} message${sent.messages === 1 ? "" : "s"}`,
    sent.events && `${sent.events} event${sent.events === 1 ? "" : "s"}`,
    sent.contacts && `${sent.contacts} contact${sent.contacts === 1 ? "" : "s"}`,
    sent.reminders && `${sent.reminders} reminder${sent.reminders === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  return parts.length === 0 ? "No data was sent." : `Sent to the provider: ${parts.join(", ")}.`;
}

export function AssistantClient() {
  const { auth, restoring } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (restoring) return;
    if (!auth) {
      router.push("/login");
      return;
    }
    apiGet<AssistantStatus>("/identity/assistant/status", auth.sessionToken)
      .then(setStatus)
      .catch((reason) => setError(errorMessage(reason)));
  }, [auth, restoring, router]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!auth || !question.trim()) return;
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      setResult(await apiPost<AskResult>("/identity/assistant/ask", { question: question.trim() }, auth.sessionToken));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAsking(false);
    }
  }

  if (restoring) return <main className={styles.shell}>Restoring your session…</main>;
  if (!auth) return <main className={styles.shell}>Redirecting to sign in…</main>;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>IDent Communications Hub</span>
          <h1>Assistant</h1>
        </div>
        <nav aria-label="Primary">
          <Link href="/inbox">Inbox</Link>
          <Link href="/contacts">Contacts</Link>
          <Link href="/calendar">Calendar</Link>
          <Link href="/account">Account</Link>
        </nav>
      </header>

      {error && <p role="alert" className={styles.error}>{error}</p>}

      <section className={styles.toolbar}>
        <div>
          <h2>Ask about your own data</h2>
          {/* Disclosure before the first question, not buried in a policy. */}
          <p>
            {status?.available
              ? `Read-only. Questions and a small, relevant slice of your data are sent to ${status.provider} (${status.model}) to generate an answer.`
              : "The assistant is not configured on this server."}
          </p>
        </div>
      </section>

      <form className={styles.search} onSubmit={ask}>
        <label htmlFor="assistant-question">Your question</label>
        <div>
          <input
            id="assistant-question"
            type="text"
            value={question}
            maxLength={500}
            placeholder="What did Jane say about the invoice?"
            onChange={(event) => setQuestion(event.target.value)}
            disabled={!status?.available}
          />
          <button type="submit" disabled={asking || !status?.available || !question.trim()}>
            {asking ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>

      {result && (
        <section className={styles.layout} aria-label="Answer">
          <article className={styles.card}>
            <pre>{result.answer}</pre>
            <p className={styles.meta}>{describeContext(result.contextSent)}</p>
            {result.refused && <p className={styles.meta}>The assistant declined this question.</p>}
          </article>
        </section>
      )}
    </main>
  );
}
