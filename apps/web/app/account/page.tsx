"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { unwrapAmk } from "../../lib/amk";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function AccountPage() {
  const router = useRouter();
  const { auth, setAuth, restoring } = useAuth();
  const [passkeyStatus, setPasskeyStatus] = useState<string | null>(null);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

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
      // The passkey factor's AMK wrap is a placeholder, not real wrapping —
      // see IDent_STATE.md: real passkey-derived AMK wrapping needs the
      // WebAuthn PRF extension, deliberately not built yet. Sending a fake
      // "encrypted" blob here would be more misleading than an honest
      // placeholder, since this passkey can't unwrap it either way.
      await apiPost(
        "/identity/webauthn/register/verify",
        { response: attestation, wrappedAmkKey: "prf-not-yet-implemented" },
        auth?.sessionToken,
      );
      setPasskeyStatus("Passkey registered — you can use it to log in next time.");
    } catch (err) {
      setPasskeyStatus(err instanceof ApiError ? err.message : "Passkey registration failed or was cancelled.");
    } finally {
      setPasskeySubmitting(false);
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

  return (
    <main>
      <h1>Account</h1>
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
        </form>
      )}
      <button type="button" onClick={handleAddPasskey} disabled={passkeySubmitting}>
        {passkeySubmitting ? "Registering passkey…" : "Register a passkey"}
      </button>
      {passkeyStatus && <p>{passkeyStatus}</p>}
      <button type="button" onClick={handleLogout} disabled={loggingOut}>
        {loggingOut ? "Logging out…" : "Log out"}
      </button>
    </main>
  );
}
