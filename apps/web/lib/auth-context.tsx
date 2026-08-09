"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * In-memory only, on purpose — nothing here survives a page reload. A real
 * persistence strategy for the session token (and never for the unwrapped
 * AMK) is a security design question of its own — localStorage is
 * XSS-exposed, cookies need CSRF handling, both need real thought. Phase 0
 * doesn't need that yet; see IDent_STATE.md.
 */
export type AuthState = {
  identityId: string;
  username: string;
  sessionToken: string;
  /** null until unwrapped — e.g. right after a passkey login, which can't unwrap it yet. */
  amk: Uint8Array | null;
};

type AuthContextValue = {
  auth: AuthState | null;
  setAuth: (auth: AuthState | null) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const value = useMemo(() => ({ auth, setAuth }), [auth]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
