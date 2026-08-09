"use client";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiPost } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function AccountPage() {
  const router = useRouter();
  const { auth, setAuth } = useAuth();
  const [passkeyStatus, setPasskeyStatus] = useState<string | null>(null);
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (!auth) router.replace("/login");
  }, [auth, router]);

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

  return (
    <main>
      <h1>Account</h1>
      <dl>
        <dt>Username</dt>
        <dd>{auth.username}</dd>
        <dt>Identity ID</dt>
        <dd>{auth.identityId}</dd>
        <dt>Account Master Key</dt>
        <dd>{auth.amk ? "Loaded in memory" : "Not available this session"}</dd>
      </dl>
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
