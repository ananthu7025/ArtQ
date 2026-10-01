# ArtQ documentation validation

Executable checks for the **schema, integrity SQL and money/stock database functions embedded in
`docs/database.md`**. This is not the application test suite (no application code exists yet).

## What it does
1. Extracts the blocks marked `<!-- validate:schema.prisma -->`, `<!-- validate:0002.sql -->` and
   `<!-- validate:0003.sql -->` from `docs/database.md` into `.fixtures/` (git-ignored).
2. `prisma validate`, then `prisma migrate diff --from-empty` → `0001.sql`.
3. Starts a throwaway PostgreSQL (default: the pinned **16.14** binaries from `embedded-postgres`;
   override with `PG_BIN_DIR`) and applies 0001 + 0002 + 0003 to a template database.
4. Runs each check in `checks/` against a fresh copy; checks marked `needs: ['redis']` also get a
   throwaway `redis-server` (override binary with `REDIS_SERVER`).
5. Prints PASS/FAIL and writes `.tmp/results-<pg-version>.json`. Exit code 1 on any failure.

## Run
```bash
cd tools/doc-validation
npm ci            # pinned: prisma 6.19.3, bullmq 5.81.5 (+ 6.3.11 for comparison), pg 8.16.3, embedded-postgres 16.14.0-beta.17
npm run validate                                  # PostgreSQL 16.14 (deployment version)
PG_BIN_DIR=/path/to/pg18/bin npm run validate     # optional forward-compatibility run
node run.mjs C03 C09                              # selected checks
```
Requirements: Node 24, `redis-server` on PATH (or `REDIS_SERVER`), and a platform supported by
`embedded-postgres` (macOS/Linux, x64/arm64) unless `PG_BIN_DIR` is set.

## Checks
| ID | Covers (review finding) |
|----|-------------------------|
| C00/C01 | Prisma validation, DDL generation, migrations apply |
| C02 | BullMQ custom job ids: colon rejected, hyphen accepted, duplicate add deduplicated (#2) |
| C03 | Same captured payment via verify + webhook + reconciliation → side effects once (#1) |
| C04 | Excess capture after partial/full refund; late capture after expiry/cancellation; mismatch held (#1) |
| C05 | Concurrent refunds on one item; shipping/COD-fee components; COD manual refunds (#4) |
| C06 | Failed refund retry after capacity reuse; per-attempt provider idempotency keys (#3, #4) |
| C07 | Outbox: Redis loses a published job → redelivered from PostgreSQL; consumer dedupe; fencing (#5) |
| C08 | Webhook lease: stalled worker fenced after reclaim (#9) |
| C09 | Multi-variant transactions + triggers under concurrency; negative control with the old trigger (#6) |
| C10 | Idempotency: cross-resource key reuse conflicts; replay/in-progress/takeover (#7) |
| C11 | Partial dimensions; return inspection quantities and finalisation (#10) |
| C12 | Publish-gate trigger; final-unit stock/coupon; invoice and order-item immutability (#10) |
| C13 | Audience-specific auth versions (#8) |

## What a PASS does and does not prove
- **Proves:** the embedded schema compiles; the SQL applies on the tested PostgreSQL versions; the database
  functions and constraints behave as documented for the scenarios above, including real concurrency
  against a real PostgreSQL and (C02, C07) a real Redis/BullMQ.
- **Does not prove:** that the future TypeScript services call these functions correctly, Razorpay's actual API
  behaviour (provider calls are simulated by passing provider results in), email delivery, HTTP/cookie/CSRF
  behaviour, UI behaviour, or performance at production scale. Those are covered by the application
  acceptance tests AT-01…AT-21 in `docs/tasklist.md`, which do not exist yet.
