# Session 5 Write Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add previewed, explicitly approved Gmail draft/archive and Calendar acceptance actions without giving model output a direct write path.

**Architecture:** Assistant retrieval emits opaque slice references; strict structured intents cross into a server-owned proposal service that persists immutable payloads and digests. Confirmation and execution are separate identity-authenticated state transitions, and provider writes occur only through injectable executors with idempotent outcome recovery.

**Tech Stack:** TypeScript, Fastify, Drizzle/Postgres, Vitest, React/Next.js, Gmail API, Google Calendar API, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-08-21-session-5-write-actions-design.md`

## Global Constraints

- Supported actions are exactly `reply.draft`, `message.archive`, and `calendar.event.accept`; sending and deletion remain absent.
- The model may reference only opaque targets in the exact persisted retrieval slice and never supplies recipients/provider IDs.
- Payloads use stable-key canonical JSON, schema version `1`, and SHA-256 digests; pending actions expire after ten minutes.
- OAuth write grants are `gmail.modify` and `calendar.events`; read-only connections continue to work but cannot execute actions until reconsented.
- Effect ceilings are 20 drafts/hour, 10 archive targets/confirmation and 50/hour, and 5 calendar accepts/hour.
- HTTP attempt limits are 10/minute/session and 30/hour/identity for confirm and execute.
- Provider ambiguity becomes `outcome_unknown`; it is never automatically retried without authoritative lookup.

---

### Task 1: Structured intents and retrieval-slice references

**Files:**
- Create: `apps/api/src/assistant/assistant-intent.ts`
- Create: `apps/api/src/assistant/assistant-intent.test.ts`
- Modify: `apps/api/src/assistant/assistant-client.ts`
- Modify: `apps/api/src/assistant/claude-client.ts`
- Modify: `apps/api/src/assistant/assistant-retrieval.ts`
- Modify: `apps/api/src/assistant/assistant-service.ts`
- Test: `apps/api/src/assistant/assistant-service.test.ts`

**Interfaces:**
- Produces: `ActionIntent`, `RetrievedReference`, `RetrievedContext.refs`, and `AssistantAnswer.actionIntents`.
- Produces: `parseActionIntents(value: unknown): ActionIntent[]` that rejects unknown fields and returns no action for answer-only providers.

- [ ] **Step 1: Write failing parser and slice-binding tests**

```ts
expect(parseActionIntents([{ type: "reply.draft", targetRef: "message:1", body: "Thanks" }])).toEqual([
  { type: "reply.draft", targetRef: "message:1", body: "Thanks" },
]);
expect(() => parseActionIntents([{ type: "message.archive", targetRefs: ["message:9"], providerId: "x" }])).toThrow();
expect(context.refs[0]).toMatchObject({ ref: "message:1", kind: "message" });
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test --workspace @ident/api -- assistant-intent.test.ts assistant-service.test.ts`

Expected: FAIL because `assistant-intent.ts`, `actionIntents`, and `refs` do not exist.

- [ ] **Step 3: Implement strict intent parsing and opaque reference output**

```ts
export type ActionIntent =
  | { type: "reply.draft"; targetRef: `message:${number}`; body: string }
  | { type: "message.archive"; targetRefs: Array<`message:${number}`> }
  | { type: "calendar.event.accept"; targetRef: `event:${number}` };

export type RetrievedReference = { ref: string; kind: "message" | "event"; id: string };
```

Claude uses its verified structured response field. OpenAI-compatible/local clients set `actionIntents: []` until a dedicated structured contract test exists; never parse prose.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test --workspace @ident/api -- assistant-intent.test.ts assistant-service.test.ts`

Expected: PASS.

```bash
git add apps/api/src/assistant
git commit -m "feat: constrain assistant write intents to retrieval slices"
```

### Task 2: Durable action state, approval, audit, and elevation capability

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrations/0018_add_assistant_write_actions.sql`
- Modify: `apps/api/src/db/migrations/meta/_journal.json`
- Create: `apps/api/src/assistant/write-actions/types.ts`
- Create: `apps/api/src/assistant/write-actions/store.ts`
- Create: `apps/api/src/assistant/write-actions/store.test.ts`
- Create: `apps/api/src/assistant/write-actions/canonical-json.ts`
- Create: `apps/api/src/assistant/write-actions/canonical-json.test.ts`

**Interfaces:**
- Produces: `PendingActionStatus`, `CanonicalActionPayload`, `createPendingAction`, `approvePendingAction`, `claimExecution`, `recordActionOutcome`, `cancelPendingAction`, and `consumeActionElevation`.
- Guarded transitions return a typed `ActionConflictError`; raw SQL/database constraint failures do not escape routes.

- [ ] **Step 1: Write failing canonicalization and concurrent-transition tests**

```ts
expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
const [a, b] = await Promise.allSettled([claimExecution(action.id), claimExecution(action.id)]);
expect([a, b].filter((x) => x.status === "fulfilled")).toHaveLength(1);
expect(await auditChainIsValid(action.id)).toBe(true);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test --workspace @ident/api -- canonical-json.test.ts store.test.ts`

Expected: FAIL because the schema and store are absent.

- [ ] **Step 3: Add the additive schema and guarded store**

```ts
export type PendingActionStatus =
  | "pending" | "approved" | "executing" | "succeeded" | "failed"
  | "outcome_unknown" | "expired" | "cancelled";

export type ActionApprovalInput = {
  actionId: string;
  identityId: string;
  sessionId: string;
  payloadDigest: string;
  now: Date;
};
```

The migration adds immutable-column and append-only triggers, unique operation keys, foreign keys, expiry/status indexes, approval rows, chained audit events, and single-use elevation consumption.

- [ ] **Step 4: Run migration/store tests and commit**

Run: `npm test --workspace @ident/api -- canonical-json.test.ts store.test.ts`

Expected: PASS including concurrent claim and append-only database rejection.

```bash
git add apps/api/src/db apps/api/src/assistant/write-actions
git commit -m "feat: persist immutable assistant action approvals"
```

### Task 3: Server proposal builder and structural injection proof

**Files:**
- Create: `apps/api/src/assistant/write-actions/proposal-service.ts`
- Create: `apps/api/src/assistant/write-actions/proposal-service.test.ts`
- Modify: `apps/api/src/assistant/assistant-service.ts`
- Modify: `apps/api/src/assistant/write-action-injection.test.ts`
- Create: `apps/api/src/assistant/write-actions/import-boundary.test.ts`

**Interfaces:**
- Consumes: `ActionIntent`, persisted `RetrievedReference[]`, and `createPendingAction`.
- Produces: `ActionProposalSink.propose(identityId, sessionId, slice, intents)` and display-safe `PendingActionPreview[]`.

- [ ] **Step 1: Write failing proposal and zero-executor tests**

```ts
await askAssistant(identityId, injectedQuestion, complyingModel, { proposalSink, executorRegistry });
expect(proposalSink.calls).toHaveLength(1);
expect(executorRegistry.calls).toHaveLength(0);
await expect(propose({ targetRef: "message:99" }, slice)).rejects.toThrow(/retrieval slice/i);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @ident/api -- proposal-service.test.ts write-action-injection.test.ts import-boundary.test.ts`

Expected: FAIL because proposal capabilities and import rules are absent.

- [ ] **Step 3: Implement server-owned payloads and previews**

```ts
export interface ActionProposalSink {
  propose(input: {
    identityId: string;
    sessionId: string;
    refs: RetrievedReference[];
    intents: ActionIntent[];
  }): Promise<PendingActionPreview[]>;
}
```

Resolve sender-only draft recipients and source/provider IDs from stores, snapshot provider/local preconditions, reject archive batches over ten, create ten-minute expiry, and return only server previews. The import-boundary test forbids assistant client/service modules from importing `write-actions/executors` or provider write clients.

- [ ] **Step 4: Run tests and commit**

Run: `npm test --workspace @ident/api -- proposal-service.test.ts write-action-injection.test.ts import-boundary.test.ts`

Expected: PASS with zero provider calls before approval.

```bash
git add apps/api/src/assistant
git commit -m "feat: build assistant action previews on the server"
```

### Task 4: Google write adapters, scope eligibility, and outcome recovery

**Files:**
- Modify: `apps/api/src/comms/connector-registry.ts`
- Modify: `apps/api/src/comms/google-oauth-client.test.ts`
- Create: `apps/api/src/comms/google-mail-write-client.ts`
- Create: `apps/api/src/comms/google-mail-write-client.test.ts`
- Create: `apps/api/src/comms/google-calendar-write-client.ts`
- Create: `apps/api/src/comms/google-calendar-write-client.test.ts`
- Create: `apps/api/src/assistant/write-actions/executors.ts`
- Create: `apps/api/src/assistant/write-actions/executors.test.ts`

**Interfaces:**
- Produces: `MailWriteClient.createReplyDraft/archiveMessage/lookupDraftOutcome` and `CalendarWriteClient.acceptInvitation/lookupAcceptanceOutcome`.
- Produces: `ActionExecutorRegistry.execute(action)` returning `succeeded | failed | outcome_unknown` with safe codes.

- [ ] **Step 1: Write failing adapter contract tests**

```ts
expect(requestedScopes()).toContain("https://www.googleapis.com/auth/gmail.modify");
expect(requestedScopes()).toContain("https://www.googleapis.com/auth/calendar.events");
expect(fakeFetch.calls[0].body).toContain("Message-ID:");
expect(await archiveMessage(alreadyArchived)).toEqual({ status: "succeeded", duplicate: true });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @ident/api -- google-oauth-client.test.ts google-mail-write-client.test.ts google-calendar-write-client.test.ts executors.test.ts`

Expected: FAIL because write scopes/adapters are absent.

- [ ] **Step 3: Implement narrow adapters and recovery lookups**

Draft MIME uses a deterministic operation-key `Message-ID`; archive removes only `INBOX`; calendar patches only the authenticated attendee to `accepted`. Fetch provider state before mutation and after ambiguous timeouts. Map provider responses to safe error codes and never log request/response bodies or tokens.

- [ ] **Step 4: Run tests and commit**

Run: `npm test --workspace @ident/api -- google-oauth-client.test.ts google-mail-write-client.test.ts google-calendar-write-client.test.ts executors.test.ts`

Expected: PASS.

```bash
git add apps/api/src/comms apps/api/src/assistant/write-actions
git commit -m "feat: execute approved Google write actions"
```

### Task 5: Confirmation/execution routes, limits, and action UI

**Files:**
- Create: `apps/api/src/assistant/write-action-routes.ts`
- Create: `apps/api/src/assistant/write-action-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/rate-limit/policy.ts`
- Modify: `apps/api/src/rate-limit/rate-limit.test.ts`
- Modify: `apps/web/app/assistant/page.tsx`
- Create: `apps/web/app/assistant/ActionCard.tsx`
- Modify: `apps/web/app/assistant/assistant.module.css`
- Modify: `apps/web/app/assistant/assistant.test.tsx`

**Interfaces:**
- Produces: GET action, POST confirm, POST execute, and POST cancel endpoints from the spec.
- Consumes: pending-action previews returned by `/identity/assistant/ask`.

- [ ] **Step 1: Write failing route/UI tests**

```ts
expect((await confirm(otherIdentityToken, action.id, digest)).statusCode).toBe(404);
expect((await confirm(ownerToken, action.id, "stale")).statusCode).toBe(409);
expect(executor.calls).toHaveLength(0);
await user.click(screen.getByRole("button", { name: /confirm/i }));
expect(await screen.findByText(/approved/i)).toBeVisible();
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test --workspace @ident/api -- write-action-routes.test.ts rate-limit.test.ts`

Run: `npm test --workspace @ident/web -- assistant.test.tsx`

Expected: FAIL because routes/cards/policies are absent.

- [ ] **Step 3: Implement routes, service limits, and explicit state UI**

```ts
app.post<{ Params: { id: string }; Body: { payloadDigest: string } }>(
  "/identity/assistant/actions/:id/confirm",
  confirmActionHandler,
);
```

Register 10/minute/session and 30/hour/identity attempt policies, enforce effect ceilings transactionally, return cross-identity actions as 404, and render reconnect/expiry/failure/unknown states without implying success.

- [ ] **Step 4: Run API/web tests and commit**

Run: `npm test --workspace @ident/api -- write-action-routes.test.ts rate-limit.test.ts`

Run: `npm test --workspace @ident/web -- assistant.test.tsx`

Expected: PASS.

```bash
git add apps/api/src apps/web/app/assistant
git commit -m "feat: confirm and execute assistant actions"
```

### Task 6: Full verification, live provider proof, and truthful status

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `IDent_STATE.md`
- Modify: `ROADMAP.md`
- Modify: `scripts/generate-progress-svg.mjs`
- Modify: `docs/progress.svg`
- Modify: `.env.example`

**Interfaces:**
- Produces: deployment/reconsent instructions and evidence-backed session status.

- [ ] **Step 1: Run automated verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit 0; migration and audit trigger tests pass.

- [ ] **Step 2: Verify Google scope migration and each action with a real account**

Reconnect the test identity, confirm the consent screen grants Gmail modify and Calendar events, create one reply draft, archive one test message, and accept one test invitation. Record provider IDs only in private verification notes; committed evidence contains timestamps and safe outcomes, not addresses/body/token data.

- [ ] **Step 3: Update documentation and progress truthfully**

Change “unblocked entirely” to “ready to start,” document reconnect requirements, action limits/states, and the structural injection proof. Mark deployed-and-verified only if Step 2 actually passed; otherwise record code-complete with the exact external verification still open.

- [ ] **Step 4: Regenerate progress and commit**

Run: `node scripts/generate-progress-svg.mjs`

```bash
git add README.md SECURITY.md IDent_STATE.md ROADMAP.md scripts/generate-progress-svg.mjs docs/progress.svg .env.example
git commit -m "docs: close session 5 with verified write-action evidence"
```
