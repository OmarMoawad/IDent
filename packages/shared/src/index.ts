export type HealthStatus = {
  status: "ok" | "degraded";
  timestamp: string;
  db: "ok" | "unreachable";
};

/** The shape POST /identity/register, /login, and /webauthn/login/verify all return. */
export type IdentitySession = {
  identityId: string;
  username: string;
  sessionToken: string;
  expiresAt: string;
};
