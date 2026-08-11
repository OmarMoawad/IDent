import "./load-env.js";
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } from "./comms/comms-config.js";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);

const app = buildApp();

// Gmail OAuth is optional infrastructure — a server with no Google Cloud
// project set up should still boot fine for identity-only use
// (comms-config.ts's own comment). But item 2.5's click-through
// (IDent_STATE.md) found that these silently evaluating to "" is exactly
// what happened for a whole day of dev:api runs before anyone noticed —
// nothing short of actually attempting a connection surfaced it. This
// warning is what should have caught it immediately at boot instead: not
// a hard failure (that would break legitimate identity-only setups), but
// impossible to miss in the startup logs if Gmail OAuth was meant to work.
if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
  app.log.warn(
    "GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET are not set — Gmail OAuth connect will fail if attempted. If you expected these to be configured, confirm .env is being loaded (see load-env.ts).",
  );
}

app
  .listen({ port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
