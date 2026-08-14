import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { insertConnectedSource, upsertMessage } from "../comms/store.js";
import { assistantModel, resolveAssistantProvider } from "./assistant-config.js";
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
 * Cost is a few cents at most against a hosted provider, and nothing at
 * all locally.
 *
 * The timeout is generous because a local model on modest hardware is
 * genuinely slow — an 8B model on an M1 spends most of a request loading
 * weights, not generating. A tight timeout here would report "broken" for
 * something that is merely slow, which is a different problem with a
 * different fix.
 */
const LIVE_TIMEOUT_MS = Number(process.env.ASSISTANT_LIVE_TIMEOUT_MS ?? 300_000);
/**
 * Gated on *any* configured provider, not on an Anthropic key specifically.
 * The first version checked ANTHROPIC_API_KEY, which meant a live local
 * model — the whole point of the provider layer — still skipped these.
 */
const provider = resolveAssistantProvider();
const hasProvider = provider !== null;

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

describe.skipIf(!hasProvider)("assistant against the live provider", () => {
  it(`serves the configured model (${assistantModel()})`, async () => {
    // This is the assertion the SDK type union could not make. If the
    // identifier is wrong, this fails with the provider's own error and
    // the default gets changed to whatever does work.
    const client = await createConfiguredAssistantClient();
    expect(client).not.toBeNull();

    const answer = await client!.ask({ question: "Reply with the single word OK.", context: "(no data)" });
    expect(answer.text.length).toBeGreaterThan(0);
    // Recorded in the run output so the tested model and date are on file.
    console.log(`[live] provider=${provider?.id} model=${assistantModel()} leavesMachine=${provider?.leavesMachine} answered; tokens in/out=${answer.usage.inputTokens}/${answer.usage.outputTokens}`);
  }, LIVE_TIMEOUT_MS);

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
  }, LIVE_TIMEOUT_MS);

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
  }, LIVE_TIMEOUT_MS);
});

describe.skipIf(hasProvider)("assistant live tests", () => {
  it("are skipped because no assistant provider is configured", () => {
    // Present so a run without a key still says out loud that the live
    // path is unproven, rather than silently reporting all-green.
    expect(hasProvider).toBe(false);
  });
});
