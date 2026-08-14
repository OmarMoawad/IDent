"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { unwrapAmk, wrapAmk } from "../../lib/amk";
import { ApiError, apiGet, apiPost, apiPut } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import {
  PRF_AMK_LOCKED_PLACEHOLDER,
  PRF_UNSUPPORTED_PLACEHOLDER,
  getPrfOutputForNewCredential,
  getPrfOutputForUnlock,
  isPrfEnabledAfterRegistration,
  unwrapAmkWithPrfOutput,
  wrapAmkWithPrfOutput,
} from "../../lib/prf";
import { normalizeRecoveryCode } from "../../lib/recovery-code";

export default function AccountPage() {
  const router = useRouter();
  const { auth, setAuth, restoring } = useAuth();
  const [passkeyStatus, setPasskeyStatus] = useState<string | null>(null);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [elevating, setElevating] = useState(false);
  const [elevateError, setElevateError] = useState<string | null>(null);
  const [elevatedUntil, setElevatedUntil] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoResult, setDemoResult] = useState<string | null>(null);
  const [demoError, setDemoError] = useState<string | null>(null);

  useEffect(() => {
    if (!restoring && !auth) router.replace("/login");
  }, [restoring, auth, router]);

  if (restoring) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }
  if (!auth) return null;

  async function handleAddPasskey() {
    setPasskeyStatus(null);
    setPasskeySubmitting(true);
    try {
      const options = await apiPost<PublicKeyCredentialCreationOptionsJSON>(
        "/identity/webauthn/register/options",
        {},
        auth?.sessionToken,
      );
      const attestation = await startRegistration({ optionsJSON: options });

      // Real PRF-derived AMK wrapping when the authenticator supports it
      // and the vault key is actually loaded to wrap; an honest,
      // distinguishable placeholder otherwise — never fabricated
      // ciphertext nothing could unwrap later. See lib/prf.ts.
      let wrappedAmkKey: string = PRF_UNSUPPORTED_PLACEHOLDER;
      let statusMessage =
        "Passkey registered — you can use it to log in, but this device can't use it to unlock your vault key (no PRF support). Unlock with your password after a passkey login instead.";

      if (isPrfEnabledAfterRegistration(attestation)) {
        if (!auth?.amk) {
          wrappedAmkKey = PRF_AMK_LOCKED_PLACEHOLDER;
          statusMessage =
            "Passkey registered — but your vault key was locked, so this passkey can't unlock it yet. Unlock with your password, then register a new passkey to enable passkey unlock.";
        } else {
          const prfOutput = await getPrfOutputForNewCredential(attestation.id);
          if (prfOutput) {
            wrappedAmkKey = await wrapAmkWithPrfOutput(auth.amk, prfOutput);
            statusMessage = "Passkey registered — you can use it to log in and unlock your vault key.";
          } else {
            statusMessage =
              "Passkey registered — you can use it to log in, but it didn't produce a vault-key secret this time. Unlock with your password after a passkey login instead.";
          }
        }
      }

      await apiPost(
        "/identity/webauthn/register/verify",
        { response: attestation, wrappedAmkKey },
        auth?.sessionToken,
      );
      setPasskeyStatus(statusMessage);
    } catch (err) {
      setPasskeyStatus(err instanceof ApiError ? err.message : "Passkey registration failed or was cancelled.");
    } finally {
      setPasskeySubmitting(false);
    }
  }

  async function handleUnlockWithPasskey() {
    setUnlockError(null);
    setUnlocking(true);
    try {
      const result = await getPrfOutputForUnlock();
      if (!result) {
        setUnlockError("That passkey can't unlock the vault key (no PRF support, or it was registered before this device could produce one).");
        return;
      }
      const wrap = await apiGet<{ wrappedKey: string }>(
        `/identity/amk-wrap?factor=passkey&credentialId=${encodeURIComponent(result.credentialId)}`,
        auth?.sessionToken,
      );
      const amk = await unwrapAmkWithPrfOutput(wrap.wrappedKey, result.prfOutput);
      setAuth(auth ? { ...auth, amk } : null);
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : "Could not unlock.");
    } finally {
      setUnlocking(false);
    }
  }

  async function handleGenerateRecoveryCode() {
    setRecoveryCode(null);
    setRecoveryStatus(null);
    setRecoverySubmitting(true);
    try {
      const { recoveryCode: code } = await apiPost<{ recoveryCode: string }>(
        "/identity/recovery/generate",
        {},
        auth?.sessionToken,
      );
      setRecoveryCode(code);

      if (auth?.amk) {
        const wrappedAmkKey = await wrapAmk(auth.amk, normalizeRecoveryCode(code));
        await apiPut("/identity/recovery/wrap", { wrappedAmkKey }, auth?.sessionToken);
        setRecoveryStatus(
          "New recovery code generated and can unlock your vault key. Any older recovery code no longer works. Save this one somewhere safe — it won't be shown again.",
        );
      } else {
        setRecoveryStatus(
          "New recovery code generated — it can log you back in, but your vault key was locked so this code can't unlock it yet. Unlock with your password, then generate a new code to enable vault-key recovery too. Save this code somewhere safe — it won't be shown again.",
        );
      }
    } catch (err) {
      setRecoveryStatus(err instanceof ApiError ? err.message : "Could not generate a recovery code.");
    } finally {
      setRecoverySubmitting(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiPost("/identity/logout", {}, auth?.sessionToken);
    } catch {
      // Clearing client-side state regardless — the session expires on its
      // own server-side even if this request didn't land.
    } finally {
      setAuth(null);
      router.push("/login");
    }
  }

  async function handleUnlock(event: FormEvent) {
    event.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      const wrap = await apiGet<{ wrappedKey: string }>("/identity/amk-wrap?factor=password", auth?.sessionToken);
      const amk = await unwrapAmk(wrap.wrappedKey, unlockPassword);
      setAuth(auth ? { ...auth, amk } : null);
      setUnlockPassword("");
    } catch (err) {
      // Covers both a wrong password (IncorrectPasswordError) and an API
      // failure (ApiError, e.g. session expired) with the same handling —
      // both have a message worth showing as-is.
      setUnlockError(err instanceof Error ? err.message : "Could not unlock.");
    } finally {
      setUnlocking(false);
    }
  }

  // Step-up / elevated sessions (SECURITY.md's tiering): re-entering the
  // password proves it's still you and unlocks the demo High/Critical-tier
  // route below for a few minutes — see apps/api's identity/elevation.ts.
  // No real High/Critical module exists yet (those are Phase 3+), so the
  // demo route is the only thing this can currently unlock.
  async function handleElevate(event: FormEvent) {
    event.preventDefault();
    setElevateError(null);
    setDemoResult(null);
    setDemoError(null);
    setElevating(true);
    try {
      const result = await apiPost<{ elevatedUntil: string; sessionToken: string }>(
        "/identity/elevate/password",
        { password: stepUpPassword },
        auth?.sessionToken,
      );
      // The API rotates the bearer token on every successful elevation (see
      // apps/api's elevation.ts) — the old token is dead the instant this
      // succeeds, so the client must switch to the new one immediately, not
      // just track elevatedUntil.
      setAuth(auth ? { ...auth, sessionToken: result.sessionToken } : null);
      setElevatedUntil(result.elevatedUntil);
      setStepUpPassword("");
    } catch (err) {
      setElevateError(err instanceof ApiError ? err.message : "Could not verify password for step-up.");
    } finally {
      setElevating(false);
    }
  }

  async function handleViewDemoSecret() {
    setDemoError(null);
    setDemoResult(null);
    setDemoLoading(true);
    try {
      const result = await apiGet<{ secret: string }>("/identity/demo/high-tier-secret", auth?.sessionToken);
      setDemoResult(result.secret);
    } catch (err) {
      // A 403 here (session valid but not elevated, or elevation expired)
      // is the expected outcome before/after step-up, not a bug — shown as
      // plain status text, not an alert.
      setDemoError(err instanceof ApiError ? err.message : "Could not reach the demo route.");
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <main>
      <h1>Account</h1>
      <p><Link href="/inbox">Open unified inbox</Link></p>
      <dl>
        <dt>Username</dt>
        <dd>{auth.username}</dd>
        <dt>Identity ID</dt>
        <dd>{auth.identityId}</dd>
        <dt>Account Master Key</dt>
        <dd>{auth.amk ? "Loaded in memory" : "Locked — enter your password to unlock"}</dd>
      </dl>
      {!auth.amk && (
        <form onSubmit={handleUnlock}>
          <label>
            Password
            <input
              type="password"
              value={unlockPassword}
              onChange={(event) => setUnlockPassword(event.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {unlockError && <p role="alert">{unlockError}</p>}
          <button type="submit" disabled={unlocking}>
            {unlocking ? "Unlocking…" : "Unlock"}
          </button>
          <button type="button" onClick={handleUnlockWithPasskey} disabled={unlocking}>
            {unlocking ? "Unlocking…" : "Unlock with passkey"}
          </button>
        </form>
      )}
      <button type="button" onClick={handleAddPasskey} disabled={passkeySubmitting}>
        {passkeySubmitting ? "Registering passkey…" : "Register a passkey"}
      </button>
      {passkeyStatus && <p>{passkeyStatus}</p>}
      <button type="button" onClick={handleGenerateRecoveryCode} disabled={recoverySubmitting}>
        {recoverySubmitting ? "Generating…" : "Generate a recovery code"}
      </button>
      {recoveryCode && (
        <p>
          Your recovery code: <code>{recoveryCode}</code>
        </p>
      )}
      {recoveryStatus && <p>{recoveryStatus}</p>}

      <h2>Step-up verification</h2>
      <p>
        Some actions need proof it&apos;s still you, on top of being logged in. Re-enter your password to
        elevate this session for a few minutes.
      </p>
      <dl>
        <dt>Elevated</dt>
        <dd>
          {elevatedUntil && new Date(elevatedUntil).getTime() > Date.now()
            ? `Yes, until ${new Date(elevatedUntil).toLocaleTimeString()}`
            : "No"}
        </dd>
      </dl>
      <form onSubmit={handleElevate}>
        <label>
          Password
          <input
            type="password"
            value={stepUpPassword}
            onChange={(event) => setStepUpPassword(event.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {elevateError && <p role="alert">{elevateError}</p>}
        <button type="submit" disabled={elevating}>
          {elevating ? "Verifying…" : "Elevate session"}
        </button>
      </form>
      <button type="button" onClick={handleViewDemoSecret} disabled={demoLoading}>
        {demoLoading ? "Loading…" : "View protected demo data"}
      </button>
      {demoResult && <p>{demoResult}</p>}
      {demoError && <p role="alert">{demoError}</p>}

      <button type="button" onClick={handleLogout} disabled={loggingOut}>
        {loggingOut ? "Logging out…" : "Log out"}
      </button>
    </main>
  );
}
