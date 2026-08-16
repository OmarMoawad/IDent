"use client";

import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { startAuthentication } from "@simplewebauthn/browser";
import type { IdentitySession } from "@ident/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { unwrapAmk } from "../../lib/amk";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { decodePrfEvalExtensions, prfOutputFromAssertion, unwrapAmkWithPrfOutput } from "../../lib/prf";
import { normalizeRecoveryCode } from "../../lib/recovery-code";
import styles from "../onboarding.module.css";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryUsername, setRecoveryUsername] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);

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
      // The server sends extensions.prf.eval.first as base64url (JSON has
      // no byte type) — decode it back to raw bytes before the real
      // WebAuthn call, which requires a BufferSource here. See
      // lib/prf.ts's decodePrfEvalExtensions for why @simplewebauthn/
      // browser doesn't do this conversion itself.
      const assertion = await startAuthentication({
        optionsJSON: { ...options, extensions: decodePrfEvalExtensions(options.extensions) },
      });
      const session = await apiPost<IdentitySession>("/identity/webauthn/login/verify", {
        username,
        response: assertion,
      });

      // The login options request already asked for a PRF evaluation (see
      // apps/api's getAuthenticationOptions), so a successful assertion
      // carries the secret needed to unwrap this credential's AMK wrap —
      // no extra ceremony. Falls back to locked (amk: null) if this
      // authenticator/passkey never produced a real wrap — see
      // account/page.tsx's unlock-with-password/passkey fallback.
      let amk: Uint8Array | null = null;
      const prfOutput = prfOutputFromAssertion(assertion);
      if (prfOutput) {
        try {
          const wrap = await apiGet<{ wrappedKey: string }>(
            `/identity/amk-wrap?factor=passkey&credentialId=${encodeURIComponent(assertion.id)}`,
            session.sessionToken,
          );
          amk = await unwrapAmkWithPrfOutput(wrap.wrappedKey, prfOutput);
        } catch (amkError) {
          console.warn("Could not unwrap AMK via passkey after login:", amkError);
        }
      }

      setAuth({
        identityId: session.identityId,
        username: session.username,
        sessionToken: session.sessionToken,
        amk,
      });
      router.push("/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Passkey sign-in failed or was cancelled.");
    } finally {
      setPasskeySubmitting(false);
    }
  }

  async function handleRecoverySubmit(event: FormEvent) {
    event.preventDefault();
    setRecoveryError(null);
    setRecoverySubmitting(true);
    try {
      const session = await apiPost<IdentitySession>("/identity/recovery/login", {
        username: recoveryUsername,
        recoveryCode,
      });

      let amk: Uint8Array | null = null;
      try {
        const wrap = await apiGet<{ wrappedKey: string }>(
          "/identity/amk-wrap?factor=recovery",
          session.sessionToken,
        );
        amk = await unwrapAmk(wrap.wrappedKey, normalizeRecoveryCode(recoveryCode));
      } catch (amkError) {
        // Same tradeoff as password login: getting in shouldn't block on the
        // vault key unwrapping (e.g. this code was generated before the AMK
        // was ever loaded — see account/page.tsx's generate-recovery-code
        // status messages).
        console.warn("Could not unwrap AMK via recovery code after login:", amkError);
      }

      setAuth({ identityId: session.identityId, username: session.username, sessionToken: session.sessionToken, amk });
      router.push("/account");
    } catch (err) {
      setRecoveryError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setRecoverySubmitting(false);
    }
  }

  return (
    <main className={styles.shell}>
      <div className={styles.card}>
      <p className={styles.eyebrow}>IDent</p>
      <h1>Log in</h1>
      <form className={styles.form} onSubmit={handlePasswordSubmit}>
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
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in with password"}
        </button>
      </form>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={handlePasskeyLogin} disabled={passkeySubmitting}>
          {passkeySubmitting ? "Waiting for passkey…" : "Log in with a passkey"}
        </button>
        <button type="button" className={styles.secondary} onClick={() => setShowRecovery((value) => !value)}>
          {showRecovery ? "Hide recovery code login" : "Lost your password and passkey? Use a recovery code"}
        </button>
      </div>
      {showRecovery && (
        <form className={styles.form} onSubmit={handleRecoverySubmit}>
          <label>
            Username
            <input
              value={recoveryUsername}
              onChange={(event) => setRecoveryUsername(event.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label>
            Recovery code
            <input
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              required
              autoComplete="off"
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            />
          </label>
          {recoveryError && <p className={styles.error} role="alert">{recoveryError}</p>}
          <button type="submit" disabled={recoverySubmitting}>
            {recoverySubmitting ? "Logging in…" : "Log in with recovery code"}
          </button>
        </form>
      )}
      <p className={styles.footerNote}>
        Need an account? <a href="/register">Register</a>
      </p>
      </div>
    </main>
  );
}
