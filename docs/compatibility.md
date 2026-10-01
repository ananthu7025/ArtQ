# ArtQ: Toolchain Compatibility (task 0.1)

> Spike run 2026-10-01 on macOS arm64, **Node v24.14.0**, pnpm 10.34.6. Re-run with `pnpm build && pnpm typecheck && pnpm test`
> and the compatibility smoke `pnpm compat:smoke` (needs `DATABASE_URL` for PostgreSQL 16 and `REDIS_URL`).

## Pinned versions

| Area | Package | Pinned | Why this version |
|------|---------|--------|------------------|
| Runtime | Node.js | 24 LTS (`>=24.11 <25`, `.nvmrc` = 24) | Supported LTS; validated on 24.14.0 |
| Package manager | pnpm (via corepack) | **10.34.6** | Stable, well-known line. 11/12 exist; upgrade is a separate decision. `onlyBuiltDependencies` allow-lists the native builds (Prisma, argon2, sharp, esbuild, msgpackr, Tailwind oxide) |
| Monorepo | turbo | 2.11.6 | |
| Language | **TypeScript 6.0.3** | | **Not 7.x:** `typescript-eslint` 8.71 (needed for task 0.2) supports `typescript <6.1`. Revisit when it supports 7 |
| Storefront | next | **16.3.8** | Current stable; App Router; build verified (static `/`) |
| Storefront/admin | react / react-dom | 19.3.0 | |
| Admin | vite / @vitejs/plugin-react | **8.3.2** / 6.1.1 | Build verified |
| Styling | tailwindcss / @tailwindcss/postcss | 4.3.3 | |
| API | express / @types/express | 5.2.1 / 5.0.6 | |
| Validation | zod | 4.6.5 | Shared schemas; strict objects verified |
| ORM | prisma / @prisma/client | **6.19.3** | The schema in database.md §5 is validated on 6.19.3. **Prisma 7.10 rejects it** with one error: `url` must move from `schema.prisma` to `prisma.config.ts`, and 7.x requires a driver adapter (`@prisma/adapter-pg`). The upgrade is small and isolated: post-MVP, or earlier if a needed fix ships only in 7 |
| Queue | bullmq | **5.81.5** | Job-id rule verified (C02); 6.3.11 also checked |
| Images | sharp | 0.35.5 (libvips 8.18.7) | Prebuilt binary on darwin-arm64 |
| Passwords | argon2 | 0.45.1 | Native build OK; argon2id m=19456 t=2 p=1 |
| MFA | otplib | **13.5.0** | v13 API: `generateSecret`, `generate`, `verify`, `generateURI` (async) |
| Excel | exceljs | 4.4.0 | xlsx write/read round-trip OK |
| PDF | @react-pdf/renderer | 4.9.0 | `renderToBuffer` OK (JSX files need the automatic runtime) |
| Logging | pino | 10.3.1 | |
| Tests | vitest / supertest | 5.0.3 / 7.3.0 | |
| Lint/format | eslint / @eslint/js / typescript-eslint / eslint-plugin-react-hooks / globals / prettier | 10.11.0 / 10.0.1 / 8.71.0 / 7.1.1 / 17.13.0 / 3.9.9 | Task 0.2 |
| HTTP middleware | helmet / cors / pino-http | 8.3.0 / 2.8.6 / 11.0.0 | Task 0.4 |
| Redis client | ioredis | 5.11.1 | Same version BullMQ 5.81.5 resolves |
| Test infra | embedded-postgres (dev) / yaml (dev) | 16.14.0-beta.17 / 2.9.1 | Real PostgreSQL 16.14 for local integration tests without Docker; CI uses service containers (`TEST_DATABASE_URL`, `TEST_REDIS_URL`) |
| Local object storage | adobe/s3mock | 5.2.3 | MinIO no longer publishes community images on Docker Hub or Quay (checked 2026-10-01) |
| Database | PostgreSQL | **16** (16.14 tested) | Deployment major (architecture.md §2) |
| Cache/queue store | Redis | 7+ (8.6.2 tested) | |

## Results

| Check | Result |
|-------|--------|
| `pnpm install` (514 packages, native builds) | PASS |
| `prisma generate` with the validated schema | PASS |
| `pnpm build` (shared, ui, api, web, admin) | PASS (5/5) |
| `pnpm typecheck` | PASS (7/7 tasks) |
| `pnpm test` | PASS (shared 4 tests, api 1 test) |
| `prisma db push` of the schema to PostgreSQL 16.14 | PASS |
| Compatibility smoke: sharp, argon2, otplib, exceljs, @react-pdf/renderer, Prisma query on PG 16.14, BullMQ job round-trip on Redis | PASS (7/7) |

## Issues found and resolved
- `tsc` declaration emit failed for the Express app (`TS2883`, non-portable inferred type). The API is a deployable, not a
  library: `declaration: false` for `apps/api`, explicit `Express` return type.
- `tsx` compiled a `.tsx` script outside the tsconfig `include` with the classic JSX runtime (`React is not defined`): fixed with
  `@jsxRuntime automatic` / `@jsxImportSource react` pragmas.

## Not yet covered (later Phase 0 tasks)
ESLint/Prettier and the "no backend code in Next.js" rule (0.2), Docker Compose (0.3), full API middleware chain (0.4),
schedulers and Bull Board (0.5), contrast test (0.6), CI (0.7, 0.9), environments (0.8). Linux/x64 (CI and production images)
is verified when CI runs in task 0.7.
