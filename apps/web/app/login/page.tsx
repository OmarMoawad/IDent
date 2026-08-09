"use client";

import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";
import type { IdentitySession } from "@ident/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { unwrapAmk } from "../../lib/amk";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await apiPost<IdentitySession>("/identity/login", { username, password });

      let amk: Uint8Array | null = null;
      try {
        const wrap = await apiGet<{ wrappedKey: string }>(
          "/identity/amk-wrap?factor=password",
          session.sessionToken,
        );
        amk = await unwrapAmk(wrap.wrappedKey, password);
      } catch (amkError) {
        // Login itself succeeded; failing to unwrap the AMK shouldn't block
        // getting in, but vault-dependent features won't work this session
        // (see IDent_STATE.md's known-gaps log).
        console.warn("Could not unwrap AMK after login:", amkError);
      }

      setAuth({ identityId: session.identityId, username: session.username, sessionToken: session.sessionToken, amk });
      router.push("/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasskeyLogin() {
    setError(null);
    if (!username) {
      setError("Enter your username first, then use the passkey button.");
      return;
    }
    setPasskeySubmitting(true);
    try {
      const options = await apiPost<PublicKeyCredentialRequestOptionsJSON>("/identity/webauthn/login/options", {
        username,
      });
      const assertion = await startAuthentication({ optionsJSON: options });
      const session = await apiPost<IdentitySession>("/identity/webauthn/login/verify", {
        username,
        response: assertion,
      });

      // Passkey login can't unwrap the AMK yet — there's no PRF-derived KEK
      // (see IDent_STATE.md) — amk stays null until that's built.
      setAuth({
        identityId: session.identityId,
        username: session.username,
        sessionToken: session.sessionToken,
        amk: null,
      });
      router.push("/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Passkey sign-in failed or was cancelled.");
    } finally {
      setPasskeySubmitting(false);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={handlePasswordSubmit}>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in with password"}
        </button>
      </form>
      <button type="button" onClick={handlePasskeyLogin} disabled={passkeySubmitting}>
        {passkeySubmitting ? "Waiting for passkey…" : "Log in with a passkey"}
      </button>
      <p>
        Need an account? <a href="/register">Register</a>
      </p>
    </main>
  );
}
