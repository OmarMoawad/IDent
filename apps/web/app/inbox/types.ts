export type InboxSource = { id: string; provider: string; status: string; providerAccountEmail: string | null };
export type InboxMessage = {
  id: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  participants: string | null;
  occurredAt: string;
  isRead: boolean;
  source: { id: string; provider: string; providerAccountEmail: string | null } | null;
};
