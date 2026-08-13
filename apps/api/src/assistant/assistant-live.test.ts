import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource, upsertMessage } from "../comms/store.js";
import { assistantModel } from "./assistant-config.js";
import { askAssistant } from "./assistant-service.js";
import { createConfiguredAssistantClient } from "./assistant-client.js";

/**
 * The one thing the fake client cannot tell us: whether the configured
 * model identifier is actually served, and whether a real request
 * succeeds end to end.
 *
 * Skipped unless ANTHROPIC_API_KEY is set, so CI stays green and nobody
 * is billed by accident. When a key *is* present these run as part of the
 * ordinary suite — no separate script to remember, and no way for the
 * repository to keep claiming the integration works without evidence.
 *
 * Cost is a few cents at most: three short requests.
 */
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());

async function seededIdentity(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/identity/register",
    payload: {
      username: `live_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      password: "correct horse battery staple",
      wrappedAmkKey: "wrap",
    },
  });
  const identity = response.json() as { identityId: string; sessionToken: string };
  const source = await insertConnectedSource({ identityId: identity.identityId, provider: "gmail" });

  await upsertMessage({
    identityId: identity.identityId,
    sourceId: source.id,
    externalId: "live-invoice",
    subject: "Invoice 4471",
    body: "The invoice total is 812 EUR, due on 30 September.",
    participants: JSON.stringify({ from: [{ name: "Acme Billing", address: "billing@acme.example" }], to: [] }),
    occurredAt: new Date("2026-08-01T10:00:00Z"),
  });
  return identity;
}

describe.skipIf(!hasKey)("assistant against the live Anthropic API", () => {
  it(`serves the configured model (${assistantModel()})`, async () => {
    // This is the assertion the SDK type union could not make. If the
    // identifier is wrong, this fails with the provider's own error and
    // the default gets changed to whatever does work.
    const client = await createConfiguredAssistantClient();
    expect(client).not.toBeNull();

    const answer = await client!.ask({ question: "Reply with the single word OK.", context: "(no data)" });
    expect(answer.text.length).toBeGreaterThan(0);
    // Recorded in the run output so the tested model and date are on file.
    console.log(`[live] model=${assistantModel()} answered; tokens in/out=${answer.usage.inputTokens}/${answer.usage.outputTokens}`);
  }, 60_000);

  it("answers a grounded question from the retrieved context", async () => {
    const app = buildApp();
    const identity = await seededIdentity(app);

    const result = await askAssistant(identity.identityId, "What is the invoice total?", await createConfiguredAssistantClient());
    expect(result.refused).toBe(false);
    // The figure is only available from the seeded message, so a correct
    // answer proves retrieval reached the model and grounding worked.
    expect(result.answer).toMatch(/812/);
    expect(result.contextSent.messages).toBeGreaterThan(0);
    await app.close();
  }, 60_000);

  it("says it cannot find something that is not in the context", async () => {
    // The failure mode that matters: inventing an answer about the user's
    // own data is worse than admitting it isn't there.
    const app = buildApp();
    const identity = await seededIdentity(app);

    const result = await askAssistant(
      identity.identityId,
      "What did my dentist say about my appointment?",
      await createConfiguredAssistantClient(),
    );
    expect(result.answer).toMatch(/not|no |couldn't|could not|don't|do not|unable/i);
    await app.close();
  }, 60_000);
});

describe.skipIf(hasKey)("assistant live tests", () => {
  it("are skipped because ANTHROPIC_API_KEY is not set", () => {
    // Present so a run without a key still says out loud that the live
    // path is unproven, rather than silently reporting all-green.
    expect(hasKey).toBe(false);
  });
});
