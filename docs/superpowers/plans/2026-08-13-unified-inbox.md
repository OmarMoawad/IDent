# Unified Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a protected unified inbox where an IDent user can inspect connected Gmail sources, sync, search, list, and read normalized messages.

**Architecture:** Extend the Communications Hub store with bounded identity-scoped queries, expose provider-neutral authenticated Fastify routes, then consume them from a focused Next.js `/inbox` client page. Gmail-specific actions remain in the existing connector routes; message presentation uses normalized IDent records only.

**Tech Stack:** TypeScript, Fastify 5, Drizzle/Postgres, Next.js 16, React 19, Vitest, Testing Library with jsdom.

## Global Constraints

- Every source/message query is scoped by authenticated `identityId` and cross-tenant detail access returns 404.
- Connected-source responses never expose encrypted token data.
- Search is case-insensitive, bounded to 200 input characters and 100 results, and covers subject, snippet, body, and participants.
- Message HTML is never rendered; bodies appear as plain React text.
- Background sync, replies/sending, contact cards, pagination, and revoked-token state redesign are out of scope.

---

### Task 1: Provider-neutral Communications Hub read API

**Files:**
- Modify: `apps/api/src/comms/store.ts`
- Modify: `apps/api/src/comms/store.test.ts`
- Create: `apps/api/src/comms/inbox-routes.ts`
- Create: `apps/api/src/comms/inbox-routes.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces: `findMessagesByIdentity(identityId: string, options?: { query?: string; limit?: number }): Promise<Message[]>`
- Produces: `GET /identity/connections`
- Produces: `GET /identity/messages?query=<text>`
- Produces: `GET /identity/messages/:messageId`

- [ ] **Step 1: Write failing store-query tests**

Add tests for 100-result cap, newest-first ordering, case-insensitive matches in subject/snippet/body/participants, empty query behavior, and identity isolation under search.

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm test -w apps/api -- src/comms/store.test.ts`

Expected: FAIL because `findMessagesByIdentity` does not accept search/limit behavior.

- [ ] **Step 3: Implement bounded store queries and verify GREEN**

Use Drizzle `and`, `eq`, `or`, `ilike`, `desc`, and `limit`. Clamp limit to 1..100 and trim the query before constructing predicates. Run the focused store test.

- [ ] **Step 4: Write failing inbox-route tests**

Create authenticated identities through `/identity/register`, seed sources/messages, then test: all routes reject missing tokens; source responses contain only `id`, `provider`, `status`, `providerAccountEmail`, `createdAt`, `updatedAt`; list/search works; 201-character query returns 400; detail returns owned data; another identity gets 404.

- [ ] **Step 5: Run route tests and verify RED**

Run: `npm test -w apps/api -- src/comms/inbox-routes.test.ts`

Expected: FAIL because routes are not registered.

- [ ] **Step 6: Implement and register routes**

Reuse `extractBearerToken` and `validateSession`. Parse query input explicitly, serialize dates as ISO strings, join each message to its already-owned source display metadata without exposing tokens, and register `registerInboxRoutes(app)` in `app.ts`.

- [ ] **Step 7: Verify Task 1 GREEN**

Run:

```bash
npm test -w apps/api -- src/comms/store.test.ts src/comms/inbox-routes.test.ts
npm run typecheck -w apps/api
```

- [ ] **Step 8: Commit Task 1**

```bash
git add apps/api/src/comms/store.ts apps/api/src/comms/store.test.ts apps/api/src/comms/inbox-routes.ts apps/api/src/comms/inbox-routes.test.ts apps/api/src/app.ts
git commit -m "feat: expose identity-scoped inbox queries"
```

### Task 2: Inbox client behavior and test harness

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/test/setup.ts`
- Create: `apps/web/app/inbox/types.ts`
- Create: `apps/web/app/inbox/inbox-client.tsx`
- Create: `apps/web/app/inbox/inbox-client.test.tsx`
- Create: `apps/web/app/inbox/page.tsx`
- Create: `apps/web/app/inbox/inbox.module.css`
- Modify: `apps/web/app/account/page.tsx`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `apiGet`, `apiPost`, AuthContext, the Task 1 APIs, and existing Gmail start/sync routes.
- Produces: protected `/inbox` page and focused `InboxClient` component.

- [ ] **Step 1: Read the installed Next.js guidance before code**

Locate and read the App Router, client-component, CSS-module, and testing-relevant documents under the installed `next/dist/docs` path required by `apps/web/AGENTS.md`. Record any version-specific constraint in the plan's implementation notes before editing.

- [ ] **Step 2: Add the minimal frontend test harness**

Install dev dependencies `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, and `@testing-library/user-event`; add `test: "vitest run"` to the web workspace. Configure jsdom and jest-dom setup.

- [ ] **Step 3: Write failing protected/empty-state tests**

Mock only the API boundary and Next router. Test restore loading, unauthenticated redirect, no-source Connect Gmail state, and connected-with-no-messages Sync now state.

- [ ] **Step 4: Run focused frontend tests and verify RED**

Run: `npm test -w apps/web -- app/inbox/inbox-client.test.tsx`

Expected: FAIL because the inbox components do not exist.

- [ ] **Step 5: Implement minimal protected loading and source states**

Use `useAuth`; defer requests until `restoring` is false; redirect missing auth; fetch `/identity/connections` and `/identity/messages`; implement Gmail start by opening the returned authorization URL and sync via the existing POST endpoint.

- [ ] **Step 6: Write failing list/search/detail/error tests**

Test newest-first response rendering, unread marker, subject fallback, submitted search and Clear search, selecting a message to fetch detail, plain-text body rendering, sync count plus refresh, and preserving the previous list when refresh/sync fails.

- [ ] **Step 7: Run tests and verify RED**

Run the same focused command and confirm the new assertions fail for missing behavior.

- [ ] **Step 8: Implement list/search/detail/error behavior**

Keep request state separated into sources, list, selected detail, active query, loading flags, and non-destructive errors. Render body in `<pre>`/plain text, never HTML injection. Add an Account → Inbox navigation link.

- [ ] **Step 9: Add responsive scoped styling**

Use a single-column default and a two-column `min-width` layout for list/reader. Preserve native semantic buttons, forms, headings, alerts, focus outlines, and readable contrast.

- [ ] **Step 10: Verify Task 2 GREEN**

Run:

```bash
npm test -w apps/web
npm run typecheck -w apps/web
npm run build -w apps/web
```

- [ ] **Step 11: Commit Task 2**

```bash
git add apps/web package-lock.json
git commit -m "feat: add the unified inbox interface"
```

### Task 3: Documentation, roadmap memory, and full verification

**Files:**
- Modify: `README.md`
- Modify: `IDent_STATE.md`
- Modify: `docs/progress.svg`

**Interfaces:**
- Produces: accurate Session 16 status and reproducible local verification instructions.

- [ ] **Step 1: Review implementation against the approved spec**

Check every API, state, privacy, error, and out-of-scope item in `docs/superpowers/specs/2026-08-13-unified-inbox-design.md`. Add any missing test before editing roadmap status.

- [ ] **Step 2: Update project documentation and living memory**

Add Inbox navigation/status to README, mark unified inbox session complete in `IDent_STATE.md` with exact test counts and limitations, preserve the revoked-token design question, and record real-browser click-through as pending unless performed. Regenerate `docs/progress.svg` with `node scripts/generate-progress-svg.mjs` when the session completion changes progress.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0 with no failures, type errors, build errors, or whitespace errors.

- [ ] **Step 4: Commit Task 3**

```bash
git add README.md IDent_STATE.md docs/progress.svg
git commit -m "docs: record unified inbox session"
```

