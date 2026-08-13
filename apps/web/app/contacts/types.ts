export type Contact = {
  id: string;
  address: string;
  displayName: string | null;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ContactMessage = {
  id: string;
  subject: string | null;
  snippet: string | null;
  occurredAt: string;
  isRead: boolean;
};

export type ContactDetail = Contact & { messages: ContactMessage[] };
