# Unified Inbox Design

## Scope

Session 16 delivers IDent's first user-facing Communications Hub surface. A signed-in identity can see connected Gmail sources, trigger the existing on-demand sync, search normalized messages, open a message, and understand empty, disconnected, loading, and failure states.

This session does not add background polling, sending/replying, contact unification, provider-native mutation, HTML rendering, pagination infrastructure, or the separate design for a source whose token was revoked outside IDent.

## Architecture

The session is a vertical slice across the existing Communications Hub boundary:

1. Store queries add bounded identity-scoped search and message detail access.
2. Authenticated Fastify routes expose connected sources, message list/search, and message detail.
3. A protected Next.js `/inbox` page consumes those routes and the existing Gmail start/sync/disconnect routes.

Provider-specific behavior stops at the source actions. The message list and detail APIs expose IDent's normalized Message shape so future providers appear without changing the inbox contract.

## API Contracts

`GET /identity/connections` returns only sources owned by the authenticated identity, with display-safe metadata and no encrypted token material.

`GET /identity/messages?query=<text>` returns at most 100 messages ordered by `occurredAt` descending. Search is case-insensitive over subject, snippet, body, and serialized participants. Empty or omitted query returns the recent list. The response includes source provider/account display metadata without exposing credentials.

`GET /identity/messages/:messageId` returns one identity-owned normalized message or 404. A message belonging to another identity is indistinguishable from a missing message.

All routes require the existing bearer session and return 401 for missing or invalid sessions. Query length is bounded and invalid input receives 400.

## Inbox User Experience

`/inbox` is a protected client page using the existing AuthContext restore behavior. Unauthenticated users are redirected to `/login`; the page does not issue data requests until restoration completes.

The page contains:

- A compact header with IDent, Inbox, and Account navigation.
- A source area showing each Gmail address and connection status.
- Connect Gmail when no connected Gmail source exists.
- Sync now per connected Gmail source, followed by a message-list refresh and an explicit imported/updated count.
- A search field whose submitted value is represented in the request and can be cleared.
- A newest-first message list showing subject fallback, participant summary, snippet, source, timestamp, and unread state.
- A message reading panel showing plain text only. Provider HTML is never rendered with `dangerouslySetInnerHTML`.

On narrow screens, list and reader stack naturally. On larger screens, they form a two-column inbox. The implementation uses focused components and a scoped stylesheet rather than expanding the already-large Account page.

## State and Error Handling

- Initial restore and fetch have explicit loading states.
- No sources: explain why the inbox is empty and offer Connect Gmail.
- Connected but no messages: offer Sync now.
- No search results: preserve the query and offer Clear search.
- Sync or fetch failure: show the API error without erasing the last successfully loaded list.
- Gmail OAuth callback statuses already sent to `/account` remain unchanged; inbox connection starts through the same tested OAuth route.
- A source that is still marked connected but has a permanently invalid token surfaces the sync error. Changing the source status is deliberately deferred to its separately recorded design task.

## Security and Privacy

- Every store query includes `identityId`; detail access uses a combined message-and-identity predicate.
- Connected-source responses omit `encryptedTokenData`.
- Search never crosses identities and has a strict result and query-size bound.
- Message bodies render as React text, not executable HTML.
- Existing bearer tokens remain in sessionStorage and are passed only through the shared API helper.

## Testing

API/store tests cover authentication, identity isolation, chronological ordering, case-insensitive search across supported fields, query bounds, source metadata sanitization, owned detail, and cross-tenant 404 behavior.

Frontend tests cover protected-page restoration, source/empty states, list rendering, search/clear, detail selection, sync refresh, and failure preservation. The web workspace receives the smallest test setup needed for these behavior tests. Full API tests, web tests, typecheck, lint/build-equivalent checks, and production builds are run before completion.

## Documentation and Roadmap State

README navigation/status, `IDent_STATE.md`, and the progress artifact are updated after verification. The session is recorded as implemented and automated-test-verified; real-browser Gmail sync/UI click-through is recorded separately and is not claimed unless it is actually performed.
