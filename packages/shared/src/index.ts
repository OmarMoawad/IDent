export type HealthStatus = {
  status: "ok" | "degraded";
  timestamp: string;
  db: "ok" | "unreachable";
  /**
   * Session 22c: readiness, not just liveness. A deployment can be up,
   * reachable and answering while missing the configuration that makes it
   * safe to serve — WebAuthn still pointed at localhost, no encryption
   * key — and "ok" would have said nothing about it.
   *
   * **Names only, never values.** This endpoint is unauthenticated by
   * design (an uptime probe cannot hold a credential), so it may report
   * that `COMMS_TOKEN_ENCRYPTION_KEY` is wrong and must never report what
   * it is.
   *
   * Optional so an older client reading this type still compiles.
   */
  missingConfig?: string[];
  insecureConfig?: string[];
  /**
   * Which commit is actually running, reported by the process itself.
   *
   * Session 23a: production built from a feature branch for a while, and
   * the only way to check what was deployed was to read the Railway
   * dashboard — which says what the platform *believes* it built. A build
   * that succeeded and a build that is serving are different claims, and
   * a dashboard cannot tell them apart after a failed redeploy silently
   * leaves the previous container up.
   *
   * Safe to expose on an unauthenticated endpoint: both repos are public
   * on purpose, so a commit SHA identifies a public object. Absent when
   * the platform injected nothing — locally, or on a host that does not
   * provide it — rather than guessed at.
   */
  commit?: string;
  branch?: string;
};

/** The shape POST /identity/register, /login, and /webauthn/login/verify all return. */
export type IdentitySession = {
  identityId: string;
  username: string;
  sessionToken: string;
  expiresAt: string;
};

export type Participant = { name?: string; address: string };

/**
 * The exact shape `messages.participants` holds, JSON-encoded — written by
 * comms/gmail-sync-service.ts, read by the inbox UI and contact
 * derivation.
 *
 * This lives in the shared package rather than in either app because the
 * two sides disagreeing about it is not hypothetical: session 16's inbox
 * UI parsed this column as a flat `Participant[]` while the sync writes an
 * `{from, to}` envelope, so every real synced message rendered as "Unknown
 * sender" (the array method threw and the UI's catch swallowed it). A
 * single exported parser both sides call is the structural fix — a
 * type-only agreement wouldn't have caught it, since the column is
 * `text` and the mismatch only appears at runtime.
 */
export type MessageParticipants = { from: Participant[]; to: Participant[] };

function asParticipantArray(value: unknown): Participant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { name, address } = entry as { name?: unknown; address?: unknown };
    if (typeof address !== "string" || !address.trim()) return [];
    return [typeof name === "string" && name.trim() ? { name: name.trim(), address: address.trim() } : { address: address.trim() }];
  });
}

/**
 * Tolerant of every shape this column has held or could hold: the current
 * `{from, to}` envelope, a bare legacy `Participant[]` (treated as
 * senders), and anything unparseable (empty envelope). Never throws —
 * callers render this, and a malformed row must not blank a whole inbox.
 */
export function parseMessageParticipants(raw: string | null | undefined): MessageParticipants {
  if (!raw) return { from: [], to: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { from: [], to: [] };
  }
  if (Array.isArray(parsed)) return { from: asParticipantArray(parsed), to: [] };
  if (typeof parsed !== "object" || parsed === null) return { from: [], to: [] };
  const { from, to } = parsed as { from?: unknown; to?: unknown };
  return { from: asParticipantArray(from), to: asParticipantArray(to) };
}

/** Normalized key identifying one person across messages: lowercased address. */
export function participantKey(address: string): string {
  return address.trim().toLowerCase();
}

/** Best human-readable label for a participant, never empty. */
export function participantLabel(participant: Participant): string {
  return participant.name?.trim() || participant.address.trim();
}
