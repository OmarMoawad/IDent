"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import type { IdentitySession } from "@ident/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { generateAmk, wrapAmk } from "../../lib/amk";
import { ApiError, apiPost, apiPut } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import {
  PRF_UNSUPPORTED_PLACEHOLDER,
  getPrfOutputForNewCredential,
  isPrfEnabledAfterRegistration,
  wrapAmkWithPrfOutput,
} from "../../lib/prf";
import { normalizeRecoveryCode } from "../../lib/recovery-code";

type PasswordlessResult = IdentitySession & { recoveryCode: string };

export default function RegisterPage() {
  const router = useRouter();
  const { setAuth } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [passwordless, setPasswordless] = useState(false);
  const [passwordlessUsername, setPasswordlessUsername] = useState("");
  const [passwordlessSubmitting, setPasswordlessSubmitting] = useState(false);
  const [passwordlessError, setPasswordlessError] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<{
    identityId: string;
    username: string;
    sessionToken: string;
    amk: Uint8Array;
  } | null>(null);
  const [pendingRecoveryCode, setPendingRecoveryCode] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const amk = generateAmk();
      const wrappedAmkKey = await wrapAmk(amk, password);
      const session = await apiPost<IdentitySession>("/identity/register", {
        username,
        password,
        wrappedAmkKey,
      });
      setAuth({
        identityId: session.identityId,
        username: session.username,
        sessionToken: session.sessionToken,
        amk,
      });
      router.push("/account");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordlessSubmit(event: FormEvent) {
    event.preventDefault();
    setPasswordlessError(null);
    setPasswordlessSubmitting(true);
    try {
      const amk = generateAmk();
      const options = await apiPost<PublicKeyCredentialCreationOptionsJSON>(
        "/identity/webauthn/register-identity/options",
        { username: passwordlessUsername },
      );
      const attestation = await startRegistration({ optionsJSON: options });

      // Same real-PRF-or-honest-placeholder logic as account/page.tsx's
      // "Register a passkey" flow — the AMK is always freshly generated and
      // already in memory here (unlike that flow), so the only placeholder
      // case that can happen is the authenticator not supporting PRF at
      // all, not the AMK being locked.
      let wrappedAmkKey: string = PRF_UNSUPPORTED_PLACEHOLDER;
      if (isPrfEnabledAfterRegistration(attestation)) {
        const prfOutput = await getPrfOutputForNewCredential(attestation.id);
        if (prfOutput) wrappedAmkKey = await wrapAmkWithPrfOutput(amk, prfOutput);
      }

      const result = await apiPost<PasswordlessResult>("/identity/webauthn/register-identity/verify", {
        username: passwordlessUsername,
        response: attestation,
        wrappedAmkKey,
      });

      // A recovery code is a mandatory part of passwordless registration
      // (see apps/api's createIdentityWithPasskey) — this identity's only
      // other factor is the one passkey just registered, so without a
      // recovery code there'd be no way back in if that device were lost.
      // Wrap the AMK with it now, in the same flow, rather than leaving it
      // as a separate step the user could skip.
      const recoveryWrappedAmkKey = await wrapAmk(amk, normalizeRecoveryCode(result.recoveryCode));
      await apiPut("/identity/recovery/wrap", { wrappedAmkKey: recoveryWrappedAmkKey }, result.sessionToken);

      // Hold off on setAuth/navigation until the user has acknowledged the
      // recovery code — it's shown exactly once, same as account/page.tsx's
      // "Generate a recovery code" button.
      setPendingAuth({
        identityId: result.identityId,
        username: result.username,
        sessionToken: result.sessionToken,
        amk,
      });
      setPendingRecoveryCode(result.recoveryCode);
    } catch (err) {
      setPasswordlessError(
        err instanceof ApiError ? err.message : "Passkey registration failed or was cancelled.",
      );
    } finally {
      setPasswordlessSubmitting(false);
    }
  }

  function handleContinueToAccount() {
    if (!pendingAuth) return;
    setAuth(pendingAuth);
    router.push("/account");
  }

  if (pendingAuth && pendingRecoveryCode) {
    return (
      <main>
        <h1>Save your recovery code</h1>
        <p>
          This is the only way back into your account if you ever lose this device — there is no password to fall
          back on. It will not be shown again.
        </p>
        <p>
          <code>{pendingRecoveryCode}</code>
        </p>
        <button type="button" onClick={handleContinueToAccount}>
          I&apos;ve saved it — continue
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Create an account</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            minLength={3}
            maxLength={32}
            pattern="[a-z][a-z0-9_]*"
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
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
      <button type="button" onClick={() => setPasswordless((value) => !value)}>
        {passwordless ? "Hide passwordless registration" : "Register with just a passkey, no password"}
      </button>
      {passwordless && (
        <form onSubmit={handlePasswordlessSubmit}>
          <label>
            Username
            <input
              value={passwordlessUsername}
              onChange={(event) => setPasswordlessUsername(event.target.value)}
              required
              minLength={3}
              maxLength={32}
              pattern="[a-z][a-z0-9_]*"
              autoComplete="username"
            />
          </label>
          {passwordlessError && <p role="alert">{passwordlessError}</p>}
          <button type="submit" disabled={passwordlessSubmitting}>
            {passwordlessSubmitting ? "Waiting for passkey…" : "Create account with a passkey"}
          </button>
        </form>
      )}
      <p>
        Already have an account? <a href="/login">Log in</a>
      </p>
    </main>
  );
}
