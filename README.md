# ArtQ

E-commerce store for wood moulds, frames, epoxy & UV resins, pigments and resin-art supplies.
Planning documentation lives in [`docs/`](docs/README.md).

## Repository layout (pnpm + Turborepo monorepo)
| Path | What |
|------|------|
| `apps/api` | Node.js 24 + Express API and BullMQ worker (the only backend) |
| `apps/web` | Next.js storefront (rendering and customer UI only) |
| `apps/admin` | React + Vite admin panel |
| `packages/shared` | Zod schemas, types, money helpers shared by all apps |
| `packages/ui` | Design tokens and shared React components |
| `packages/config` | TypeScript base configs |
| `tools/doc-validation` | Executable checks of the database design in `docs/database.md` (standalone npm package) |

## Getting started
```bash
nvm use                      # Node 24
corepack enable pnpm         # pnpm 10.34.6 (from package.json "packageManager")
pnpm install
pnpm --filter @artq/api prisma:generate
pnpm build && pnpm typecheck && pnpm test

pnpm --filter @artq/api dev      # API on :4000  (GET /health)
pnpm --filter @artq/web dev      # storefront on :3000
pnpm --filter @artq/admin dev    # admin on :5173
```
### Local services (Docker)
```bash
docker compose up -d --wait          # PostgreSQL 16 :55432, Redis 7 :56379, S3Mock :9090, Mailpit SMTP :1025 / UI :8025
cp .env.example apps/api/.env
pnpm --filter @artq/api migrate:deploy             # apply prisma/migrations to the compose database
pnpm --filter @artq/api test:compose               # smoke tests against the running stack
pnpm --filter @artq/api test:compose:integration   # integration suites against the containers
docker compose down                  # (add -v to delete data)
```
Without Docker, `pnpm test` still runs the integration tests using a throwaway PostgreSQL 16.14 (embedded-postgres) and `redis-server` from PATH.
