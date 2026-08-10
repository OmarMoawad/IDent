/**
 * Mirrors apps/api's identity/recovery-code.ts normalizeRecoveryCode exactly
 * — the AMK wrap/unwrap KEK is derived from this normalized string (see
 * lib/amk.ts's wrapAmk/unwrapAmk), so client and server must agree on
 * whitespace/hyphens/case or a correctly-typed code would fail to unwrap
 * even though the server accepted it for login.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/-/g, "");
}
