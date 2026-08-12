export type Participant = { name?: string; address: string };

/**
 * Parses an RFC 5322-ish header value ("From"/"To") into the
 * {name, address}[] shape messages.participants stores as JSON (see
 * schema.ts's comment on that column — no dedicated Contact table yet).
 * Deliberately forgiving rather than a full RFC 5322 parser: this is
 * display metadata for an inbox UI, not a security boundary, so a header
 * this can't confidently split just becomes a single address-only entry
 * instead of throwing.
 */
export function parseParticipants(header: string | null | undefined): Participant[] {
  if (!header) return [];
  // Split on commas that aren't inside a quoted display name (e.g. the
  // comma in `"Doe, Jane" <jane@example.com>`).
  const parts = header.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  const entries: Participant[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angleMatch = part.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    if (angleMatch) {
      const name = angleMatch[1].trim();
      entries.push(name ? { name, address: angleMatch[2].trim() } : { address: angleMatch[2].trim() });
    } else {
      entries.push({ address: part });
    }
  }
  return entries;
}
