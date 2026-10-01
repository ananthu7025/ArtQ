# ArtQ: working rules for this repository

Read `docs/README.md` first; `docs/tasklist.md` is the plan and `docs/architecture.md` / `docs/database.md` are the contracts.

## Testing rule (every testable change)
1. **Every testable feature or fix ships with automated tests in the same change.** Cover:
   - **Happy path**: the normal successful flow.
   - **Negative paths**: invalid input, missing/extra fields, unauthorized or forbidden callers, wrong state, not found.
   - **Edge and failure cases**: boundaries (0, max, exactly-at-limit), duplicates/retries, concurrency where state is shared,
     dependency failures (database, Redis, provider down or timing out).
2. **Run the whole automated suite before declaring work done**, not just the new tests:
   `pnpm build && pnpm typecheck && pnpm lint && pnpm test` (plus `pnpm validate:docs` when `docs/database.md` or
   `tools/doc-validation/**` changed, and, with `docker compose up -d --wait`, both `pnpm --filter @artq/api test:compose` and
   `pnpm --filter @artq/api test:compose:integration` when infrastructure or integration code changed). Report the real results; never claim a pass that was not run. If a test cannot run
   locally (e.g. Docker unavailable), say exactly what was not executed.
3. Do not weaken or delete a test to make it pass; fix the code or explain why the test is wrong.

## Commit rule (every phase)
1. Work for a phase happens on a branch named `phase-<n>` (never directly on `main`).
2. **When a phase is complete** (all its tasks done and the full suite green), commit with a message summarising the phase,
   the tasks completed and the test results, and tick the tasks in `docs/tasklist.md` in the same commit.
3. Commit also at a meaningful checkpoint inside a long phase if the suite is green.
4. Never push, merge or open a PR unless asked.

## Architecture guard-rails
- `apps/web` is frontend only: no `app/api/**` route handlers, no `"use server"` (enforced by `pnpm lint:boundaries`).
- All money/stock transactions go through the `aq_*` database functions in `docs/database.md` §6b.
- Pinned toolchain: see `docs/compatibility.md` (Node 24, pnpm 10.34.6, TypeScript 6.0.3, Prisma 6.19.3).
