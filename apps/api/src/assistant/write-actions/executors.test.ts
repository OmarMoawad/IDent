import { describe, expect, it } from "vitest";
import type { MailWriteClient, WriteOutcome } from "../../comms/google-mail-write-client.js";
import type { CalendarWriteClient } from "../../comms/google-calendar-write-client.js";
import { DefaultActionExecutorRegistry, type WriteTokenProvider } from "./executors.js";
import type { PendingActionRow } from "./types.js";

const tokenOk: WriteTokenProvider = { async tokenFor() { return { accessToken: "tok" }; } };
const tokenIneligible: WriteTokenProvider = { async tokenFor() { return { ineligible: "missing_scope" }; } };

function recordingMail(outcome: WriteOutcome): MailWriteClient & { drafts: number; archives: number } {
  return {
    drafts: 0,
    archives: 0,
    async createReplyDraft() {
      this.drafts += 1;
      return outcome;
    },
    async archiveMessage() {
      this.archives += 1;
      return outcome;
    },
    async lookupDraftOutcome() {
      return outcome;
    },
  };
}

const noopCalendar: CalendarWriteClient = {
  async acceptInvitation() {
    return { status: "succeeded" };
  },
  async lookupAcceptanceOutcome() {
    return { status: "succeeded" };
  },
};

function action(overrides: Partial<PendingActionRow> & { actionType: string; canonicalPayload: string }): PendingActionRow {
  return {
    id: "a1",
    identityId: "id1",
    requestingSessionId: "s1",
    schemaVersion: 1,
    payloadDigest: "d",
    retrievalSlice: "[]",
    preconditions: "{}",
    status: "executing",
    operationKey: "op-1",
    outcomeCode: null,
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PendingActionRow;
}

describe("DefaultActionExecutorRegistry", () => {
  it("dispatches a reply draft to the mail client", async () => {
    const mail = recordingMail({ status: "succeeded", providerId: "d1" });
    const registry = new DefaultActionExecutorRegistry(tokenOk, mail, noopCalendar);

    const result = await registry.execute(
      action({
        actionType: "reply.draft",
        canonicalPayload: JSON.stringify({ sourceId: "src", providerMessageId: "m", to: "j@x.com", subject: "Re", body: "hi" }),
      }),
    );

    expect(result).toEqual({ status: "succeeded", code: "ok" });
    expect(mail.drafts).toBe(1);
  });

  it("reports an ineligible connection as a failure without calling the provider", async () => {
    const mail = recordingMail({ status: "succeeded" });
    const registry = new DefaultActionExecutorRegistry(tokenIneligible, mail, noopCalendar);

    const result = await registry.execute(
      action({
        actionType: "message.archive",
        canonicalPayload: JSON.stringify({ targets: [{ sourceId: "src", providerMessageId: "m" }] }),
      }),
    );

    expect(result).toEqual({ status: "failed", code: "ineligible:missing_scope" });
    expect(mail.archives).toBe(0);
  });

  it("marks a duplicate archive as a success", async () => {
    const mail = recordingMail({ status: "succeeded", duplicate: true });
    const registry = new DefaultActionExecutorRegistry(tokenOk, mail, noopCalendar);

    const result = await registry.execute(
      action({
        actionType: "message.archive",
        canonicalPayload: JSON.stringify({ targets: [{ sourceId: "src", providerMessageId: "m" }] }),
      }),
    );
    expect(result).toEqual({ status: "succeeded", code: "duplicate" });
  });

  it("makes a batch outcome_unknown if any target is unresolved", async () => {
    const mail: MailWriteClient = {
      async createReplyDraft() { return { status: "succeeded" }; },
      async archiveMessage(_t, id) {
        return id === "bad" ? { status: "outcome_unknown", code: "archive_unconfirmed" } : { status: "succeeded" };
      },
      async lookupDraftOutcome() { return { status: "succeeded" }; },
    };
    const registry = new DefaultActionExecutorRegistry(tokenOk, mail, noopCalendar);

    const result = await registry.execute(
      action({
        actionType: "message.archive",
        canonicalPayload: JSON.stringify({ targets: [{ sourceId: "src", providerMessageId: "ok" }, { sourceId: "src", providerMessageId: "bad" }] }),
      }),
    );
    expect(result).toEqual({ status: "outcome_unknown", code: "partial_unknown" });
  });
});
