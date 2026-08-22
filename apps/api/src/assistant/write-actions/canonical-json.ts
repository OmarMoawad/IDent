import { createHash } from "node:crypto";

/**
 * Phase 2 session 5. The bytes a human actually approves.
 *
 * The whole confirmation guarantee rests on one thing: the digest the user
 * confirmed and the digest the server executes are computed over the *same*
 * bytes. So the serialisation has to be deterministic — the same payload
 * must always produce the same string, regardless of the order its keys
 * happened to be built in. `JSON.stringify` is not deterministic across
 * key insertion order, so this canonicaliser sorts every object's keys
 * (recursively) before emitting them. Arrays keep their order, because
 * order is meaningful there (the list of archive targets is a sequence).
 *
 * Non-finite numbers and `undefined` are rejected rather than coerced:
 * `JSON.stringify` turns them into `null` or drops them silently, and a
 * payload that serialises to something other than what it holds is exactly
 * the kind of gap a digest exists to close.
 */

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export class NonCanonicalizableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonCanonicalizableError";
  }
}

export function canonicalize(value: CanonicalValue): string {
  if (value === null) return "null";

  const kind = typeof value;
  if (kind === "string") return JSON.stringify(value);
  if (kind === "boolean") return value ? "true" : "false";
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new NonCanonicalizableError("Cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(assertDefined(item))).join(",")}]`;
  }

  if (kind === "object") {
    const record = value as { [key: string]: CanonicalValue };
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(assertDefined(record[key]))}`);
    return `{${entries.join(",")}}`;
  }

  throw new NonCanonicalizableError(`Cannot canonicalize a value of type ${kind}`);
}

function assertDefined(value: CanonicalValue): CanonicalValue {
  if (value === undefined) {
    throw new NonCanonicalizableError("Cannot canonicalize an undefined value");
  }
  return value;
}

/** SHA-256 of the canonical bytes, hex — what the UI echoes back on confirm. */
export function digestCanonical(value: CanonicalValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
