# Developing IDent

Phase 0A scaffold. See [IDent_STATE.md](IDent_STATE.md) for what's actually
done vs. pending before assuming anything below is production-ready.

## Prerequisites

- Node.js 20+
- Docker (for local Postgres)

## Setup

```bash
cp .env.example .env
npm install
docker compose up -d          # starts Postgres on localhost:5432
npm run db:generate -w apps/api   # generate migrations from src/db/schema.ts
npm run db:migrate -w apps/api    # apply migrations
```

## Running

```bash
npm run dev:api   # Fastify API on http://localhost:4000 (see /health)
npm run dev:web   # Next.js app on http://localhost:3000
```

## Checks (same as CI)

```bash
npm run typecheck
npm run test
npm run build
```

## Layout

```
apps/
  api/      Fastify backend — src/index.ts is the entrypoint, src/db/ is the
            Postgres + Drizzle migration setup
  web/      Next.js frontend (App Router)
packages/
  shared/   Types shared between api and web (@ident/shared)
```

Identity/domain schema (users, sessions, keys) is Phase 0B, not part of this
scaffold — `src/db/schema.ts` currently holds only an infra-proving table
that confirms migrations run end to end.
