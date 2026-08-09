export function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function requireStrings(body: Record<string, unknown>, keys: string[]): string[] | null {
  const values = keys.map((key) => body[key]);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) return null;
  return values as string[];
}
