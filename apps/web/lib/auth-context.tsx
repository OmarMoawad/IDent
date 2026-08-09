"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet } from "./api";

/**
 * Only the session token persists across a reload (sessionStorage: dies
 * with the tab, never shared across tabs, never written to disk the way
 * localStorage is). The AMK never does, deliberately — a reload always
 * comes back "locked" (amk: null) and the account page's unlock flow
 * re-derives it from a freshly-entered password. See IDent_STATE.md for
 * the full rationale.
 */
const SESSION_TOKEN_KEY = "ident.sessionToken";

export type AuthState = {
  identityId: string;
  username: string;
  sessionToken: string;
  /** null until unwrapped — after a passkey login, or after restoring a session on reload. */
  amk: Uint8Array | null;
};

type AuthContextValue = {
  auth: AuthState | null;
  setAuth: (auth: AuthState | null) => void;
  /** true until the initial sessionStorage-restore attempt finishes — protected pages should wait on this before redirecting to /login. */
  restoring: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuthState] = useState<AuthState | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
      setRestoring(false);
      return;
    }
    apiGet<{ identityId: string; username: string }>("/identity/me", token)
      .then((identity) => {
        setAuthState({ identityId: identity.identityId, username: identity.username, sessionToken: token, amk: null });
      })
      .catch(() => {
        // Token expired, was revoked, or the API is unreachable — either
        // way, don't keep presenting the app as logged in.
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
      })
      .finally(() => setRestoring(false));
  }, []);

  const setAuth = useCallback((next: AuthState | null) => {
    setAuthState(next);
    if (next) sessionStorage.setItem(SESSION_TOKEN_KEY, next.sessionToken);
    else sessionStorage.removeItem(SESSION_TOKEN_KEY);
  }, []);

  const value = useMemo(() => ({ auth, setAuth, restoring }), [auth, setAuth, restoring]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
