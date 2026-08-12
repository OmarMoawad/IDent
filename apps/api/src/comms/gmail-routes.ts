import type { FastifyInstance } from "fastify";
import { ORIGIN } from "../identity/webauthn-config.js";
import { extractBearerToken } from "../identity/http.js";
import { validateSession } from "../identity/service.js";
import {
  ConnectedSourceNotConnectedError,
  ConnectedSourceNotFoundError,
  ConnectedSourceOwnershipError,
  OauthStateInvalidError,
  completeGmailConnection,
  disconnectGmailSource,
  startGmailConnection,
} from "./gmail-service.js";
import { syncGmailMessages } from "./gmail-sync-service.js";
import { GoogleOAuthError } from "./google-oauth-client.js";

type GmailCallbackQuery = { code?: string; state?: string; error?: string };
type DisconnectParams = { sourceId: string };
type SyncParams = { sourceId: string };

export function registerGmailRoutes(app: FastifyInstance): void {
  app.post("/identity/connections/gmail/start", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    const { authorizationUrl } = await startGmailConnection(identity.identityId);
    return reply.code(200).send({ authorizationUrl });
  });

  // No session gate here — this is an anonymous top-level browser redirect
  // from Google, not an XHR/fetch from apps/web, so it carries no bearer
  // token. The state parameter is what ties it back to the identity that
  // started the flow — see completeGmailConnection's and
  // oauth_state_challenges' comments for why.
  app.get<{ Querystring: GmailCallbackQuery }>("/identity/connections/gmail/callback", async (request, reply) => {
    const { code, state, error } = request.query;

    if (error) {
      // The user declined consent, or Google itself errored — not a bug
      // here, send them back to the app with an honest status instead of
      // a raw API error page.
      return reply.redirect(`${ORIGIN}/account?gmail=denied`);
    }
    if (!code || !state) {
      return reply.code(400).send({ error: "code and state are required." });
    }

    try {
      await completeGmailConnection(code, state);
      return reply.redirect(`${ORIGIN}/account?gmail=connected`);
    } catch (err) {
      if (err instanceof OauthStateInvalidError || err instanceof GoogleOAuthError) {
        return reply.redirect(`${ORIGIN}/account?gmail=error`);
      }
      throw err;
    }
  });

  app.post<{ Params: DisconnectParams }>(
    "/identity/connections/gmail/:sourceId/disconnect",
    async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      const identity = token ? await validateSession(token) : null;
      if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

      try {
        await disconnectGmailSource(identity.identityId, request.params.sourceId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof ConnectedSourceNotFoundError) return reply.code(404).send({ error: err.message });
        if (err instanceof ConnectedSourceOwnershipError) return reply.code(403).send({ error: err.message });
        throw err;
      }
    },
  );

  // Session 15: on-demand message sync — a user-triggered "Sync now"
  // action, not a background poller (see gmail-sync-service.ts's header for
  // why). Pulls the most recent GMAIL_SYNC_MAX_MESSAGES messages every
  // call; upsertMessage's (sourceId, externalId) uniqueness (store.ts)
  // makes repeated syncs idempotent rather than accumulating duplicates.
  app.post<{ Params: SyncParams }>("/identity/connections/gmail/:sourceId/sync", async (request, reply) => {
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await validateSession(token) : null;
    if (!identity) return reply.code(401).send({ error: "Missing or invalid session token." });

    try {
      const result = await syncGmailMessages(identity.identityId, request.params.sourceId);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ConnectedSourceNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof ConnectedSourceOwnershipError) return reply.code(403).send({ error: err.message });
      if (err instanceof ConnectedSourceNotConnectedError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
