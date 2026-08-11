import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "dotenv";

// Bare `import "dotenv/config"` resolves .env relative to process.cwd() —
// but `npm run dev -w apps/api` (this repo's own documented `npm run
// dev:api`, DEVELOPMENT.md) sets cwd to apps/api, not the repo root where
// .env actually lives. That means every entry point that used to do
// `import "dotenv/config"` was silently loading nothing: no error, just
// GOOGLE_OAUTH_CLIENT_ID/SECRET (and anything else without a hardcoded
// dev fallback) staying empty strings. Found via the real-browser Gmail
// OAuth click-through (IDent_STATE.md item 2.5) — the authorization URL
// it built had `client_id=` with nothing after it, which would have
// failed at Google's consent screen. Path resolved from this file's own
// location instead of cwd, so it's correct regardless of which directory
// a script is invoked from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(repoRoot, ".env") });
