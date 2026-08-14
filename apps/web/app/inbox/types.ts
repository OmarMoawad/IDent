export type InboxSource = { id: string; provider: string; status: string; providerAccountEmail: string | null };
export type InboxMessage = {
  /** "message" | "notification" — the unified inbox lists both. */
  kind?: string;
  actionUrl?: string | null;
  id: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  participants: string | null;
  occurredAt: string;
  isRead: boolean;
  source: { id: string; provider: string; providerAccountEmail: string | null } | null;
};
