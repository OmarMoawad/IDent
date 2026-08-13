import { and, desc, eq } from "drizzle-orm";
import { parseMessageParticipants, participantKey } from "@ident/shared";
import { db } from "../db/client.js";
import { messagePriorities, priorityRules } from "../db/schema.js";
import { findMessagesByIdentity, type Message } from "../comms/store.js";

/**
 * Phase 1 session 19 — negotiated importance filtering.
 *
 * ROADMAP.md sets the rules for this feature, and they are the reason it
 * is built the way it is rather than as a classifier plus a filter:
 *
 *   1. Negotiated, not silent — every call carries a human-readable reason.
 *   2. Nothing hidden — this module only *labels*; no caller filters on it.
 *   3. Overridable at both levels — one message, or the rule behind it.
 *   4. Tunable per source/contact — that is what priorityRules are.
 *   5. Stated preferences beat the model's guess — enforced by ordering:
 *      the heuristic runs first, then user rules overwrite it, then an
 *      explicit per-message override overwrites that.
 */

export type PriorityLevel = "high" | "normal" | "low";
export const PRIORITY_LEVELS: PriorityLevel[] = ["high", "normal", "low"];

export function isPriorityLevel(value: unknown): value is PriorityLevel {
  return typeof value === "string" && (PRIORITY_LEVELS as string[]).includes(value);
}

export type MessagePriority = {
  messageId: string;
  level: PriorityLevel;
  reason: string;
  assignedBy: "assistant" | "user" | "rule";
  ruleId: string | null;
};

export type PriorityRule = {
  id: string;
  matchType: "contact" | "source";
  matchValue: string;
  level: PriorityLevel;
  createdAt: Date;
};

/**
 * A deliberately simple, *explainable* heuristic rather than a model call.
 *
 * The roadmap requires the user be able to see why something was
 * deprioritized. A transparent rule ("no reply expected — looks like a
 * newsletter") satisfies that; "the model said so" does not. This also
 * keeps the free tier free and sends nothing to a third party — an
 * LLM-backed pass could be layered on later behind the same interface, but
 * it would owe the same explanation.
 */
const BULK_MARKERS = /\b(unsubscribe|newsletter|no-?reply|do-?not-?reply|promotional|marketing)\b/i;
const URGENT_MARKERS = /\b(urgent|asap|deadline|overdue|action required|payment failed|security alert)\b/i;
const DIRECT_QUESTION = /\?\s*$|\b(can you|could you|are you|will you|please)\b/i;

export function classifyMessage(message: Pick<Message, "subject" | "snippet" | "body" | "participants">): {
  level: PriorityLevel;
  reason: string;
} {
  const haystack = [message.subject, message.snippet, message.body].filter(Boolean).join(" ");
  const { from, to } = parseMessageParticipants(message.participants);

  if (URGENT_MARKERS.test(haystack)) {
    return { level: "high", reason: "Mentions something time-critical, such as a deadline or an alert." };
  }
  if (BULK_MARKERS.test(haystack) || from.some((p) => /no-?reply|newsletter/i.test(p.address))) {
    return { level: "low", reason: "Looks like bulk mail — it carries unsubscribe or no-reply markers." };
  }
  // Addressed to you alone and asking something: the classic "needs a reply".
  if (to.length <= 1 && DIRECT_QUESTION.test(haystack)) {
    return { level: "high", reason: "Addressed to you directly and appears to ask a question." };
  }
  if (to.length > 5) {
    return { level: "low", reason: "Sent to a large group, so it is unlikely to need your individual reply." };
  }
  return { level: "normal", reason: "No strong signal either way." };
}

export async function findPriorityRules(identityId: string): Promise<PriorityRule[]> {
  const rows = await db
    .select({
      id: priorityRules.id,
      matchType: priorityRules.matchType,
      matchValue: priorityRules.matchValue,
      level: priorityRules.level,
      createdAt: priorityRules.createdAt,
    })
    .from(priorityRules)
    .where(eq(priorityRules.identityId, identityId))
    .orderBy(desc(priorityRules.createdAt));
  return rows as PriorityRule[];
}

/**
 * The rule that applies to a message, if any. Contact rules are matched
 * against every participant, so a rule about a person applies whether they
 * sent the message or were copied on it.
 */
function matchRule(message: Message, rules: PriorityRule[]): PriorityRule | null {
  const { from, to } = parseMessageParticipants(message.participants);
  const addresses = new Set([...from, ...to].map((p) => participantKey(p.address)));

  for (const rule of rules) {
    if (rule.matchType === "contact" && addresses.has(participantKey(rule.matchValue))) return rule;
    if (rule.matchType === "source" && rule.matchValue === message.sourceId) return rule;
  }
  return null;
}

export type ClassifyResult = { classified: number; byLevel: Record<PriorityLevel, number> };

/**
 * Labels the identity's messages. Ordering is the feature: the heuristic
 * proposes, a matching user rule overrides it, and an existing explicit
 * user override on a message is never touched at all.
 */
export async function classifyMessagesForIdentity(identityId: string): Promise<ClassifyResult> {
  const [messages, rules, existing] = await Promise.all([
    findMessagesByIdentity(identityId, { limit: 100 }),
    findPriorityRules(identityId),
    db
      .select({ messageId: messagePriorities.messageId, assignedBy: messagePriorities.assignedBy })
      .from(messagePriorities)
      .where(eq(messagePriorities.identityId, identityId)),
  ]);

  // A call the user made by hand outranks anything computed here.
  const userOverridden = new Set(
    existing.filter((row) => row.assignedBy === "user").map((row) => row.messageId),
  );

  const byLevel: Record<PriorityLevel, number> = { high: 0, normal: 0, low: 0 };
  let classified = 0;

  for (const message of messages) {
    if (userOverridden.has(message.id)) continue;

    const guess = classifyMessage(message);
    const rule = matchRule(message, rules);
    // Stated preference wins over the guess — ROADMAP.md's own requirement.
    const level = rule ? (rule.level as PriorityLevel) : guess.level;
    const reason = rule
      ? `Your rule for ${rule.matchType === "contact" ? rule.matchValue : "this source"} marks it ${rule.level}.`
      : guess.reason;

    await db
      .insert(messagePriorities)
      .values({
        identityId,
        messageId: message.id,
        level,
        reason,
        assignedBy: rule ? "rule" : "assistant",
        ruleId: rule?.id ?? null,
      })
      .onConflictDoUpdate({
        target: messagePriorities.messageId,
        set: { level, reason, assignedBy: rule ? "rule" : "assistant", ruleId: rule?.id ?? null },
      });

    byLevel[level] += 1;
    classified += 1;
  }

  return { classified, byLevel };
}

export async function findPrioritiesByIdentity(identityId: string): Promise<MessagePriority[]> {
  const rows = await db
    .select({
      messageId: messagePriorities.messageId,
      level: messagePriorities.level,
      reason: messagePriorities.reason,
      assignedBy: messagePriorities.assignedBy,
      ruleId: messagePriorities.ruleId,
    })
    .from(messagePriorities)
    .where(eq(messagePriorities.identityId, identityId));
  return rows as MessagePriority[];
}

/**
 * A per-message override. Recorded as `assignedBy: "user"` so a later
 * re-classification leaves it alone — the user's explicit call is durable,
 * not something the next sync quietly reverts.
 */
export async function overrideMessagePriority(
  identityId: string,
  messageId: string,
  level: PriorityLevel,
): Promise<boolean> {
  // Scoped insert: the message must belong to this identity, so a guessed
  // id from another tenant writes nothing.
  const owned = await findMessagesByIdentity(identityId, { limit: 100 });
  if (!owned.some((message) => message.id === messageId)) return false;

  await db
    .insert(messagePriorities)
    .values({
      identityId,
      messageId,
      level,
      reason: "You set this priority yourself.",
      assignedBy: "user",
      ruleId: null,
    })
    .onConflictDoUpdate({
      target: messagePriorities.messageId,
      set: { level, reason: "You set this priority yourself.", assignedBy: "user", ruleId: null },
    });
  return true;
}

export async function createPriorityRule(input: {
  identityId: string;
  matchType: "contact" | "source";
  matchValue: string;
  level: PriorityLevel;
}): Promise<PriorityRule> {
  const [row] = await db
    .insert(priorityRules)
    .values({
      identityId: input.identityId,
      matchType: input.matchType,
      matchValue: input.matchType === "contact" ? participantKey(input.matchValue) : input.matchValue,
      level: input.level,
    })
    .onConflictDoUpdate({
      target: [priorityRules.identityId, priorityRules.matchType, priorityRules.matchValue],
      set: { level: input.level },
    })
    .returning({
      id: priorityRules.id,
      matchType: priorityRules.matchType,
      matchValue: priorityRules.matchValue,
      level: priorityRules.level,
      createdAt: priorityRules.createdAt,
    });
  return row as PriorityRule;
}

export async function deletePriorityRule(id: string, identityId: string): Promise<boolean> {
  const rows = await db
    .delete(priorityRules)
    .where(and(eq(priorityRules.id, id), eq(priorityRules.identityId, identityId)))
    .returning({ id: priorityRules.id });
  return rows.length > 0;
}
