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

## Validation rule: one set of criteria, front and back (every form, strict)
1. **Frontend and backend validate with the same criteria.** A request schema lives once, in `packages/shared`
   (`@artq/shared`), as Zod; the API endpoint and the form both import it. The form may only *add* client-only fields
   (e.g. "repeat password") on top of the shared schema; it never loosens or re-types a rule (lengths, formats, ranges,
   enums, required/optional). A field the server rejects must be rejected by the form with the same limit, and vice versa.
2. **Frontend validation uses Zod** (React Hook Form + `zodResolver`), never ad-hoc checks or HTML `required`/`pattern`
   as the only guard.
3. **Every invalid field shows it the same way:** red border on the input (`aria-invalid="true"`, styled globally) and the
   message directly under the field in red, linked with `aria-describedby`. Server-side `VALIDATION_ERROR` details are
   mapped back onto the same fields; only errors that belong to no field go in the form-level alert.
4. Tests for each form cover: empty submit shows the field messages, each limit at the boundary (exactly-at-limit passes,
   one over fails) on both the form and the API, and a server field error lands on its field.

## Architecture guard-rails
- `apps/web` is frontend only: no `app/api/**` route handlers, no `"use server"` (enforced by `pnpm lint:boundaries`).
- All money/stock transactions go through the `aq_*` database functions in `docs/database.md` §6b, called via the typed
  wrappers in `apps/api/src/db/functions.ts` (one wrapper per function, no logic; enforced by `test/db-artifacts.test.ts`).
- Database changes: the initial schema and migrations `0001`–`0003` are generated from `docs/database.md`
  (`pnpm --filter @artq/api db:from-docs`; `pnpm lint` fails on drift). Later changes are new migrations `0004+`, additive
  only (expand → migrate → contract, architecture.md §12); destructive SQL needs a `-- contract-phase: <reason>` line or
  `pnpm lint` fails.
- Pinned toolchain: see `docs/compatibility.md` (Node 24, pnpm 10.34.6, TypeScript 6.0.3, Prisma 6.19.3).
