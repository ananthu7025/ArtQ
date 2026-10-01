# ArtQ: Delivery Plan & Task List

> Each task: ID, scope, ✅ acceptance criteria, estimate in **developer-days (d)**. Status `[ ]` todo · `[~]` doing · `[x]` done.
> Revised after two reviews ([review.md](review.md)). **Baseline: the original plan (commit `fe85b89`) totals 94 dev-days**: its phase table and its 69 task estimates both sum to 94 (6+12+11+15+8+14+11+8+9). Its header text said "≈ 95–110 dev-days". The second review's "104" could not be reproduced from the repository, so 94 is kept (review.md §5, finding 11).

## Assumptions
- Team: **1 senior full-stack lead + 1 frontend-leaning developer**; part-time designer and QA are **not** counted in dev-days.
- **Productive capacity:** 4 dev-days per developer per week (meetings, reviews, client calls, context switching), so **8 dev-days/week** for the team.
- Estimates include unit/integration tests for the task. The cross-cutting acceptance suite is task 7.1.
- Client inputs arrive on the dates in §Client inputs. Each week of delay on a blocking input moves the dependent milestone by the same amount.
- No application code exists yet. The repository contains these docs, the client files and `tools/doc-validation` (executable checks of the database layer only).

## Summary

| Phase | Name | Outcome | Dev-days |
|-------|------|---------|---------:|
| 0 | Foundations & compatibility | Node 24 toolchain proven, CI (incl. doc validation), environments, tokens | 7.5 |
| 1 | Core platform & security | Schema + money/stock functions, customer auth, **admin MFA**, permissions, audit, outbox deliveries, fenced inbox, fenced idempotency, media | 19.5 |
| 2 | Catalogue & admin catalogue | Products page, editor, gate, import, inventory, all behind secure admin | 16 |
| 3 | Storefront browsing | Home, listing, PDP, search with correct caching | 13 |
| 4 | **Purchase flow** | Cart, coupons, shipping, checkout, Razorpay, COD, reconciliation (incl. UNLINKED recovery, refunded-first payments) | 20 |
| 5 | **Merchant operations** | Orders, fulfilment, invoices, cancellations, refunds (attempts + provider idempotency + provider-refund reconciliation), returns, COD, exceptions | 19 |
| 6 | Content, SEO, admin completeness | CMS, content pages, SEO, staff/settings/audit UIs | 7 |
| 7 | Hardening & launch | Acceptance suite (AT-01…AT-24), perf, security, a11y, restore drill, go-live | 12.5 |
| | **MVP total** | | **114.5** |
| | Contingency (15 %) | | **17** |
| | **Planned MVP effort** | | **131.5 dev-days** |

**Calendar duration:** 131.5 ÷ 8 dev-days/week ≈ **16.5 weeks** of build. With typical client-input waits (photos, counts, accountant approval, Razorpay live KYC), plan for **17–20 weeks** from kickoff to launch. Dev-days measure effort; weeks are calendar time with two people working in parallel.

**Why it changed (131.5 d vs. the 94 d baseline, +37.5 d):**
- **+20.5 d of MVP scope (114.5 vs 94):**
  - First review: about +24.5 d of new reliability and security work (admin MFA and session rotation, payment attempts and the recovery matrix, reconciliation, durable inbox, outbox, idempotency, reservation-based inventory, coupon reservation, refunds with item allocation, credit notes, COD remittance/RTO, returns workflow, publication gate, import row outcomes/resume, private media, SSRF-safe fetching, exception and jobs views, promotion pipeline, restore drill, acceptance suite).
  - Second review: +3.5 d. Doc-validation CI gate +0.5 (0.9); money/stock database functions +1 (1.1); per-consumer outbox deliveries with fenced leases +0.5 (1.8); fenced webhook leases +0.5 (1.9); refund attempts with `X-Refund-Idempotency` +0.5 (5.4); seven additional acceptance scenarios +0.5 (7.1).
  - Third review: +1 d. Fenced idempotency ownership (owner token, assert/attach/renew/complete, resume-on-takeover) +0.5 (1.10); UNLINKED payment recovery and reconciliation of payments first seen refunded +0.5 (4.9). Two acceptance scenarios (AT-22, AT-23) reuse existing harness work (7.1 unchanged).
  - Fourth review: +0.5 d. Provider-refund reconciliation (`aq_reconcile_provider_refunds`, refund gate, matching own refunds) in 5.4; derived `PROCESSING` reassessment is inside existing 4.9 work; AT-24 reuses the harness.
  - −9 d moved to the post-launch backlog: collections, abandoned carts, advanced reports, reviews, SMS.
  - Check: 94 + 24.5 + 3.5 + 1 + 0.5 − 9 = 114.5.
- **+17 d contingency (15 % of 114.5 = 17.2, rounded).** The baseline plan had none.

## Milestones
| Milestone | End of | What is demonstrable |
|-----------|--------|----------------------|
| **M0** Foundations | Phase 0 | All apps build and deploy to staging on Node 24; compatibility report |
| **M1** Secure catalogue admin | Phase 2 | Staff log in with MFA; the client's catalogue is imported as drafts with flags; the Products page matches the screenshot plus extensions; STAFF cannot change prices |
| **M2** First working purchase | Phase 4 | On staging (Razorpay test mode): browse → cart → coupon → checkout → pay (UPI/card) or COD → order placed → emails; failure paths recover; reconciliation runs |
| **M3** Merchant operations | Phase 5 | Confirm → pack → ship (invoice issued) → deliver; cancel with automatic refund; return → inspect → refund → credit note; COD remittance; exceptions queue |
| **M4** Launch | Phase 7 | Production live after acceptance suite, restore drill and accountant sign-off |

Reconciliation, refund safety, authorization and inventory correctness are **MVP** (Phases 1, 4, 5), not post-launch.

---

## Phase 0: Foundations & compatibility (7.5 d)
- [x] **0.1 Compatibility spike + monorepo** (1.5 d): pnpm + Turborepo; `apps/web` (Next.js), `apps/admin` (Vite), `apps/api` (Express), `packages/{shared,ui,config}`; `.nvmrc` 24, `engines` `>=24.11 <25`. Smoke-test on Node 24: Next build, Vite build, Prisma 6.19 generate + migrate, sharp, argon2, BullMQ/ioredis, exceljs, @react-pdf/renderer, otplib; evaluate Prisma 7.
  ✅ `pnpm build && pnpm test` green on Node 24 in CI; pinned versions recorded in docs/compatibility.md; any incompatibility has a documented substitute. **Done locally 2026-10-01** (CI part completes with 0.7): build 5/5, typecheck, tests, compatibility smoke 7/7 on Node 24.14.0 + PostgreSQL 16.14 + Redis; TypeScript pinned to 6.0.3, Prisma kept at 6.19.3 (7.10 needs `prisma.config.ts` + driver adapter).
- [x] **0.2 Code quality** (0.5 d): ESLint, Prettier, strict TS, Husky, commitlint; a lint rule/CI grep forbidding `app/api/**` and `"use server"` in `apps/web`.
  ✅ CI fails if Next.js gains backend code.
  **Done 2026-10-01:** ESLint 10 flat config (typescript-eslint, react-hooks), Prettier config, `pnpm lint` = ESLint + `lint:boundaries` (no `app/api`, `route.*`, `pages/api`, `"use server"` in apps/web; backend imports blocked); checker has 8 tests and was verified failing on planted violations. Husky/commitlint **not added**: commit hooks would block the team's current commits; enforcement moves to the CI gate (0.7).
- [x] **0.3 Local infrastructure** (0.5 d): docker-compose (PostgreSQL 16, Redis 7 AOF, MinIO with public+private buckets, Mailpit); `.env.example`.
  ✅ Fresh clone → running stack in < 15 min.
  **Done and verified 2026-10-01 on Docker Desktop 29.8.1 / Compose v5.5.1:** `docker-compose.yml` with postgres 16.14, redis 7.4 (AOF), **S3Mock 5.2.3** instead of MinIO (MinIO images are no longer published on Docker Hub/Quay; S3Mock does not enforce bucket privacy, so private-file access is verified against R2 on staging), mailpit 1.31.3; all tags verified to exist. `.env.example` is tested to cover every API env variable and to load as a valid config. Host ports are localhost-only and non-default (Postgres **55432**, Redis **56379**; overridable via `ARTQ_*_PORT`) after a real clash with an existing local PostgreSQL on 5432 and Redis on 6379. `docker compose up -d --wait` → all services healthy; `pnpm --filter @artq/api test:compose` (10 tests: PG 16 + extensions + wrong password, Redis 7 AOF, S3 buckets/put/get/404s, Mailpit SMTP→API, API readiness with `.env.example`) and `test:compose:integration` (readiness + worker suites against the containers, 12 tests) pass. That run also exposed a non-portable test (wrong-password case assumed `postgres:postgres` credentials), now fixed.
- [x] **0.4 API skeleton** (1 d): middleware chain (architecture.md §4) incl. origin guard stub, JSON-only enforcement, strict zod, error format, `/health`, `/health/ready`.
  ✅ Form-encoded POST → 415; unknown body key → 400.
  **Done 2026-10-01:** zod-validated env (fails fast with all issues), request id, pino-http, helmet, CORS allowlist (not authorization), JSON-only 415, strict validation 400, origin guard 403, error shape, 404/413/500 mapping, `/health` and `/health/ready` with timeouts. 44 tests incl. readiness against real PostgreSQL 16.14 + Redis (up, Redis down, DB down, wrong password).
- [x] **0.5 Worker skeleton** (0.5 d): BullMQ queues, repeatable schedulers registered at start, Bull Board (admin-only later).
  ✅ Scheduler re-registers after worker restart.
  **Done 2026-10-01:** worker runtime with upserted job schedulers, safe `jobId()` builder (rejects `:`), retries/backoff, retention; 12 tests incl. 8 against real Redis (scheduler fires, restart re-registers without duplicates and updates interval, duplicate job id processed once, failing job retried then failed while others continue, jobs added while stopped processed after restart, unknown queue rejected, unreachable Redis fails fast). Found and fixed: stop() right after start() leaked a rejected promise; start() now waits for worker connections. Bull Board is deferred to task 5.8 (it needs admin auth).
- [x] **0.6 Design tokens & primitives** (1.5 d): tokens from design-system.md (accessible `brand-700` action colour), primitives, **contrast unit test** over the token pairs in design-system.md §2.3.
  ✅ Test fails if any text pair < 4.5:1 or UI boundary < 3:1.
  **Done 2026-10-01:** `packages/ui/src/tokens.ts` is the single source of truth; `tokens.css` (CSS variables) and `theme.css` (Tailwind v4 `@theme`) are tested to match it exactly. WCAG contrast utility + test over all 20 allowed pairs (text ≥ 4.5, UI ≥ 3) and 3 forbidden pairs that must fail. Primitives: Button (aria-disabled/aria-busy, no double submit), IconButton (mandatory label), Input (label, aria-invalid, aria-describedby), Badge, Price (paise, MRP/discount), SectionTitle, Skeleton; 47 tests incl. axe-core scan. Web build-output test (5) checks the token utilities, the prerendered page and that no route handlers exist; it caught `Button` needing `'use client'` for server rendering. Drawer/Modal/Toast need focus management and move to task 3.1. jsdom pinned to 29.1.1 (30.x requires Node ≥ 24.15).
- [x] **0.7 CI** (0.5 d): lint → typecheck → unit → integration with Testcontainers (Postgres, Redis) → build; migration check (fails on destructive SQL without an `-- contract-phase` marker).
  ✅ Required checks on `main`.
  **Done 2026-10-01 (workflow written and rehearsed; not yet executed on GitHub, which needs a push):** `.github/workflows/ci.yml` with jobs `verify` (install → prisma generate → build → typecheck → lint → test, integration against PostgreSQL 16.14 + Redis 7.4 service containers), `compose` (real `docker compose up --wait` + both compose suites) and `doc-validation`; actions pinned to current majors (checkout/setup-node/upload-artifact v7, cache v6); `actionlint` 1.7.12 clean. Rehearsal in a clean `node:24-bookworm` Linux container (Node 24.21.0) against the compose services: all steps green, 124 tests. The rehearsal found that Turborepo's strict env mode dropped `TEST_DATABASE_URL`/`TEST_REDIS_URL`, which would have broken CI on the first push; fixed with `env` on the turbo `test` task. Migration destructive-SQL check moves to 1.1 (no migrations exist yet). Branch protection (required checks) is a GitHub setting for the repo owner.
- [ ] **0.8 Environments & promotion** (1 d): staging + production projects with isolated DB/Redis/R2/secrets; API image built once per SHA, deployed to staging, promoted by digest to prod after approval; Vercel promote; Sentry.
  ✅ Promotion of the same digest demonstrated; staging cannot reach prod resources.
- [x] **0.9 Doc-validation gate** (0.5 d): run `tools/doc-validation` (PostgreSQL 16.14 + Redis) in CI on every change to `docs/database.md` or `tools/doc-validation/**`; publish the results JSON as a build artifact.
  ✅ A PR that breaks the embedded schema, SQL or functions cannot merge.
  **Done 2026-10-01 (rehearsed, not yet run on GitHub):** `doc-validation` job in ci.yml (apt `redis-server`, `npm ci`, `npm run validate`, results JSON uploaded as an artifact). Runs on every push/PR (≈ 2 min) rather than only on path changes, so it can be a required check. Rehearsed as a non-root user in Linux: 17/17 PASS on PostgreSQL 16.14 + Redis 7.0.15.

## Phase 1: Core platform & security (19.5 d)
- [x] **1.1 Schema, migrations & money/stock functions** (3 d): database.md §5 + database.md §6 + database.md §6b as `0001_init` + `0002_constraints_search_integrity` + `0003_money_stock_functions`, copied verbatim from the validated doc blocks; thin typed wrappers in `apps/api` for every `aq_*` function (no re-implementation of their logic).
  ✅ Applies on empty DB; constraint tests (publish gate, refund cap, snapshot/invoice immutability, coupon capacity, category/type FK) pass.
  **Done 2026-10-01:** `apps/api/scripts/db-from-docs.mjs` generates `schema.prisma` and the three migrations from the validated blocks (`--check` runs in `pnpm lint`); `scripts/check-migrations.mjs` is the destructive-SQL guard deferred from 0.7 (`-- contract-phase: <reason>` marker; function bodies, strings and comments ignored). `src/db/functions.ts`: 39 wrappers for the 39 `aq_*` functions; `src/db/errors.ts` maps raised codes to `DbFunctionError`. Integration tests run the real `prisma migrate deploy` (template DB per server, clone per test file): 74 tables, no-op re-run, migration replay identical, a failed migration blocks later deploys, and all acceptance constraints plus stock/payment/refund/idempotency/webhook/outbox/session paths including concurrency races. Prisma reports 4 objects from 0002 it cannot express (composite FK `products_category_matches_type_fk`, 3 GIN indexes) as drift: pinned in a test, and any generated migration that drops them fails the destructive-SQL guard. **Defect found and fixed:** `aq_reserve_coupon` compared the `citext` email with a `TEXT` parameter, which is case-sensitive, so a guest could bypass a per-customer limit by changing letter case; fixed in database.md §6b (`p_email::citext`), regression added to doc-validation C12 (fails on the old SQL) and to the API tests.
- [ ] **1.2 Shared pure functions** (2 d): money, tax rounding (database.md §4.4), slug, size normalisation, pricing (architecture.md §6.4) and the **single shipping algorithm** (architecture.md §6.5) with ≥ 40 table tests (threshold edges, coupon pushing below threshold, FREE_SHIPPING coupon, > 10 kg cap, volumetric > actual, COD fee never waived, non-serviceable pincode).
  ✅ All examples in product.md §8.2 and architecture.md §6.5 reproduced exactly.
- [ ] **1.3 Seeds** (1 d): geo + GST codes, postal codes, zones/slabs/extra-per-kg, settings, first SUPER_ADMIN (must enrol MFA).
  ✅ Idempotent re-run.
- [ ] **1.4 Customer auth** (3 d): signup + email OTP, login (email+password / email OTP), cookie helper (create/clear identical attributes, env-specific names), refresh rotation with 30 s grace, reuse detection → session revoke, session cache + revocation, logout/logout-all, forgot/reset, set-password link, verified-email guest-order linking.
  ✅ AT-11 passes; reused token outside grace revokes the session; blocked user's next request → 401.
- [ ] **1.5 Origin/CSRF guard & rate limits** (0.5 d).
  ✅ Cookie route POST with foreign/missing Origin → 403; webhooks exempt.
- [ ] **1.6 Admin auth with mandatory MFA** (2 d): login → challenge, enrolment (encrypted secret, QR, recovery codes), verify, recovery code use, step-up, replay prevention, MFA reset, break-glass CLI, separate admin cookie/audience.
  ✅ No token is issued before MFA; a recovery code works once; storefront token rejected on `/admin`.
- [ ] **1.7 Permissions & audit** (1 d): permission map (architecture.md §5.9), `requirePermission`, per-permission strict schemas, audit middleware.
  ✅ AT-10 (STAFF price change) passes.
- [ ] **1.8 Outbox deliveries + email consumer** (2 d): consumer map for `aq_emit`; dispatcher loop claim (short TX) → `queue.add` with `outbox-<deliveryId>-<generation>` outside any TX → fenced `aq_outbox_mark_published` / `aq_outbox_publish_failed`; consumer wrapper `aq_outbox_begin_consume` … `aq_outbox_complete`; email consumer with `email_logs` dedupe and provider idempotency key; retention jobs.
  ✅ Kill dispatcher between enqueue and commit → no duplicate email; outbox DEAD → exception.
- [ ] **1.9 Webhook inbox framework** (1.5 d): signature verify, durable insert, ack-after-commit, `wh-<id>` enqueue, fenced lease (`aq_webhook_claim/begin/renew/complete/fail`), retry/backoff, DEAD, sweeper.
  ✅ AT-04 passes on a synthetic provider.
- [ ] **1.10 Idempotency middleware** (1.5 d): scope/operation/key/target fingerprint, PROCESSING lock, replay, conflict; **owner token** from `aq_idempotency_begin` carried through the request; `aq_idempotency_assert_owner` as the first statement of each transaction; attach/renew/complete with the token; `IDEMPOTENCY_OWNERSHIP_LOST` → 409 `REQUEST_SUPERSEDED`; resume-on-takeover helpers for order, attempt and refund; 24 h purge.
  ✅ AT-02 passes.
- [ ] **1.11 Media** (2 d): presign with size/type constraints, complete with HEAD check, worker sniff + sharp re-encode, states, private bucket + authorized redirects, SSRF-safe fetcher.
  ✅ Spoofed MIME rejected; private URL denied to other users; fetcher refuses `http://169.254.169.254`, `localhost`, redirect-to-private, > 20 MB.

## Phase 2: Catalogue & admin catalogue (16 d)
- [ ] **2.1 Admin shell** (2 d): login/MFA screens, permission-aware navigation in screenshot order (product.md §7.2), **independently scrollable sidebar** + < 1024 px drawer, DataTable (server-side pagination/filter/sort, loading/empty/error, bulk selection), mutation feedback, version-conflict dialog.
  ✅ Every nav item reachable at 1280×720, 1024×600 and 200 % zoom (Playwright); axe passes.
- [ ] **2.2 Catalogue services** (2 d): products/variants CRUD (content), **separate pricing endpoint**, aggregates in the same TX, optimistic versions, slug redirects, search triggers.
  ✅ Variant price change updates `min_price` in the same TX; `product_aggregate_drift` empty after 1,000 random edits.
- [ ] **2.3 Publication gate** (1.5 d): readiness evaluation, publish/unpublish/archive endpoints, edit-guard for ACTIVE products, tax approval.
  ✅ Each of the product.md §8.7 checks individually blocks publish.
- [ ] **2.4 Products page** (2 d): search, Add Product, type tabs + More + Unassigned, #/Image/Name/Type/Status/Variants/Actions, activation toggle with gate popover, Edit/Delete(Archive), Previous/Next + page; price range, available stock, status/stock/readiness/image filters, bulk actions, import/export buttons, variant drawer.
  ✅ Contract test: no row renders "Unknown"; image states rendered distinctly; STAFF sees read-only price cells and toggle.
- [ ] **2.5 Product editor** (3 d): all sections in product.md §7.4 incl. variants grid with gated commercial columns and readiness panel.
  ✅ Recreate "Teak Wood Frame" (14 variants) in < 5 min.
- [ ] **2.6 Product Types / Categories / Techniques** (1 d).
  ✅ Delete in use → 409 with guidance.
- [ ] **2.7 Catalogue import** (3 d): parser for template + Sheet1 layout, flags (catalog.md §6), row outcomes, `NEEDS_REVIEW` on version conflicts, batch resume with advisory lock, SSRF-safe image fetch, result file; UI preview/confirm/progress/resolve.
  ✅ Client file → 64 drafts / 98 variants with the documented flags; killing the worker mid-import and restarting completes without duplicates; re-import changes no stock.
- [ ] **2.8 Inventory** (1.5 d): recount/adjust/write-off (on_hand only), ledger, inventory import, oversold exception, low-stock list.
  ✅ AT-13 passes.

## Phase 3: Storefront browsing (13 d)
- [ ] **3.1 Layout shell** (2 d): announcement (accessible colours), header, mega-menu, drawer, footer, WhatsApp, toasts.
- [ ] **3.2 Data layer & caching** (1 d): public SSR fetch (ISR 60 s) vs browser fetch (`credentials:'include'`); API cache headers per allow-list; `no-store` everywhere else.
  ✅ Integration test asserts headers for every route group; personal routes never public-cacheable.
- [ ] **3.3 Home** (2.5 d) ✅ LCP < 2.5 s on throttled 4G.
- [ ] **3.4 Product card + quick add** (1 d).
- [ ] **3.5 Listing** (3 d): same-variant filter semantics, facets, URL state.
  ✅ Product with gold-out-of-stock + silver-in-stock does not match "Gold + in stock".
- [ ] **3.6 PDP** (2.5 d): live availability, notify-me, pincode serviceability, JSON-LD.
- [ ] **3.7 Search UX** (1 d).

## Phase 4: Purchase flow (20 d) → **M2**
- [ ] **4.0 Razorpay spike** (0.5 d): on the test account confirm fetch-by-receipt, order payments list, capture, refunds with receipt, event-id header, late authorization behaviour, auto-capture setting.
  ✅ Findings recorded; any gap has a documented fallback.
- [ ] **4.1 Cart backend** (1.5 d): token cookie, re-pricing, clamping, merge.
- [ ] **4.2 Storefront auth & account basics** (2.5 d): login/signup/OTP/forgot/reset/set-password pages; **refresh coordinator** (Web Locks + BroadcastChannel); profile, email change, addresses, wishlist.
  ✅ AT-11 (multi-tab) passes in Playwright.
- [ ] **4.3 Coupons** (2 d): validation, reservation lifecycle (reserve/redeem/release/reverse/over-limit), admin Coupons module.
  ✅ AT-09 passes; expiring an unpaid order never decrements `redeemed_count`.
- [ ] **4.4 Shipping Rates & serviceability admin** (1.5 d): zones, slabs, extra/kg, threshold/cap, packaging, pincode rules + CSV, preview.
- [ ] **4.5 Cart page + mini-cart** (1.5 d).
- [ ] **4.6 Checkout page** (2.5 d): contact (unverified), address + serviceability, payment options, processing/failed/retry states.
- [ ] **4.7 Initiate** (2 d): idempotent initiate, TX1/TX2, attempts, one pending order per cart, failure matrix rows 1–6 (architecture.md §7.3).
  ✅ AT-01, AT-02, AT-03 pass.
- [ ] **4.8 Verify, status, retry, COD** (2 d): stored provider order id, signature, provider fetch, amount/currency/status checks, `PROCESSING` state, polling endpoint, payment retry (idempotent), COD placement.
- [ ] **4.9 Webhooks, reconciliation, expiry, late/excess captures** (3 d): Razorpay handlers on the inbox (payment snapshot incl. `amount_refunded`), reconcile-attempts incl. **UNLINKED recovery** sweep, expire-pending with pre-check, daily reconciliation (first-seen-refunded payments → VOID/HELD; ledger vs provider refunds → RECON_MISMATCH), derived `PROCESSING` reassessment (authorizations voided by the provider return the order to UNPAID so it expires), exceptions creation.
  ✅ AT-04, AT-05, AT-06, AT-07 pass.
- [ ] **4.10 Order notifications & confirmation** (1 d): outbox events → emails, success/processing pages, analytics `purchase` once.
- [ ] **M2 demo** on staging.

## Phase 5: Merchant operations (19 d) → **M3**
- [ ] **5.1 Admin Orders** (2.5 d): list filters (4 dimensions + exceptions), detail, transitions, packing slip, address correction, resend email.
- [ ] **5.2 Dispatch & invoices** (2 d): convert database.md §8.4 into an `aq_dispatch_order` function (consume reservations, shipment, invoice numbering + immutable snapshot, outbox) **and add a doc-validation check for it**; PDF render (private).
  ✅ Invoice sequence gap-free under 20 concurrent dispatches.
- [ ] **5.3 Cancellation** (1.5 d): customer/admin, release, automatic refund for prepaid, coupon reversal policy.
- [ ] **5.4 Refunds** (4 d): provider-refund reconciliation (`refunds.reconcile` → `aq_reconcile_provider_refunds`, `REFUND_RECONCILIATION_REQUIRED` gate surfaced in the refundable calculator and admin UI); refundable calculator (reserved vs available at item/shipping/COD-fee/order/payment level), `aq_request_refund`/`aq_retry_refund`/`aq_cancel_manual_refund`, `refund.send` consumer with `X-Refund-Idempotency` + stored immutable body, outcome mapping (architecture.md §10.2), webhook + reconcile by receipt/notes, manual COD refunds, credit notes.
  ✅ AT-08 passes.
- [ ] **5.5 Returns** (2.5 d): customer request (account + guest), private photos, decide → transit → receive → inspect → refund → close; quantity bounds.
  ✅ Duplicate/excess return quantities rejected under concurrency.
- [ ] **5.6 COD, RTO, lost** (1.5 d): COD collected/remitted, remittance recording + mismatch, RTO receive/inspect/restock, lost write-off.
- [ ] **5.7 Customer & guest order access** (2 d): account orders, guest tracking link, email-OTP order access cookie, cancel/return/invoice, attachment authorization.
  ✅ AT-12 passes.
- [ ] **5.8 Exceptions & ops views** (1.5 d): Payment Exceptions, Jobs & Webhooks, alert wiring (architecture.md §13).
- [ ] **5.9 Dashboard, Customers, Restock Requests** (1.5 d).
- [ ] **M3 demo** with the client's admin user.

## Phase 6: Content, SEO, admin completeness (7 d)
- [ ] **6.1 CMS & Messages admin** (2 d).
- [ ] **6.2 Content pages** (1 d): about, contact, custom work (private uploads), FAQs, policies, 404.
- [ ] **6.3 Newsletter & back-in-stock** (1 d).
- [ ] **6.4 SEO** (2 d): metadata, JSON-LD, sitemap, robots, canonical, redirects.
- [ ] **6.5 Staff & Permissions, Settings, Audit Logs UIs** (1 d).

## Phase 7: Hardening & launch (12.5 d) → **M4**
- [ ] **7.1 Acceptance suite** (4.5 d): implement AT-01…AT-24 (below) in CI (integration with Testcontainers + Playwright on staging).
- [ ] **7.2 Performance** (1.5 d): Lighthouse, bundle, `EXPLAIN` on listing/search, k6 (100 rps listing, 20 rps checkout quote).
- [ ] **7.3 Security review** (1.5 d): auth/session, CSRF/Origin, IDOR (orders, attachments, addresses), SSRF, upload validation, permission matrix, secrets.
- [ ] **7.4 Accessibility & browsers** (1 d): storefront **and admin** (contrast, keyboard, reachable nav).
- [ ] **7.5 Business sign-off** (1 d): accountant approves invoice/credit-note format and tax data (D-1–D-3); catalogue readiness review; policies text.
- [ ] **7.6 Production readiness** (1.5 d): prod infra, backups/PITR, R2 sync, alerts, on-call runbooks; **restore drill** (AT-14).
- [ ] **7.7 Launch & hypercare** (1.5 d): live ₹1 test order + refund, monitor 48 h, admin training.

---

## Acceptance tests (required for launch)

| ID | Scenario | Level | Pass criteria |
|----|----------|-------|---------------|
| **AT-01** | Concurrent checkout against limited stock: 20 carts buy the last 5 units at once | Integration (real Postgres) | Exactly 5 orders; `reserved = 5`; others 409; no negative available; drift views empty |
| **AT-02** | Concurrent repeated idempotency keys: 10 parallel initiates with the same key + 1 with a different body | Integration | One order; 9 get replay or `REQUEST_IN_PROGRESS`; different body → 422 |
| **AT-03** | Provider success then local failure: Razorpay order created, process killed before TX2; client retries with same key | Integration (provider stub) | Attempt adopted by receipt; single provider order; no duplicate order; reconciler resolves if no retry |
| **AT-04** | Webhook crash after durable receipt: inbox row committed, worker killed mid-processing | Integration | Endpoint returned 200 only after commit; sweeper reclaims after lock expiry; order paid exactly once |
| **AT-05** | Duplicate captured payment via **browser verify + webhook + reconciler** (concurrently and repeated), then a late `authorized`; refund events reversed | Integration | Exactly one `APPLIED`; coupon, sold count, cart, history, `order.placed` each once; rank stays CAPTURED; refund ends PROCESSED; one email per dedupe key (DB-level: C03) |
| **AT-06** | Multiple distinct captures for one order (two attempts both paid) | Integration | First APPLIED; second EXCESS + exception + automatic refund; `captured_amount` = order total (C04) |
| **AT-07** | Capture racing expiry and cancellation | Integration | Before expiry → order placed, not expired; after expiry with stock → restored; after expiry without stock → refunded + exception; after cancellation → refunded, never revived |
| **AT-08** | Concurrent refunds targeting **the same item** while the payment still has room; concurrent shipping/COD-fee refunds; COD manual refunds | Integration | Item, shipping, COD-fee, order and payment limits all hold; losers get 409 `REFUND_EXCEEDS_CAPACITY` with scope (C05) |
| **AT-09** | Concurrent final coupon use: 10 checkouts with a limit-1 coupon | Integration | One RESERVED; others 422; expiry releases without touching `redeemed_count` |
| **AT-10** | STAFF attempting price changes via inventory, variant, bulk and import endpoints | API | All rejected (403/400 unknown key); audit records attempts; prices unchanged |
| **AT-11** | Refresh across reloads and multiple tabs: 3 tabs, reload, concurrent refresh, stolen-token replay | Playwright + API | No logout on concurrent refresh (grace); replay after grace revokes session; logout propagates to all tabs |
| **AT-12** | Guest order and attachment access isolation | API + Playwright | Tracking link read-only; actions need email OTP; cookie scoped to one order; other orders'/users' attachments → 404/403; presigned URLs expire |
| **AT-13** | Imports during reservations: inventory import sets on_hand while 3 orders hold reservations; catalogue re-import | Integration | `reserved` unchanged; available recalculated; count < reserved raises OVERSOLD; catalogue import changes no stock |
| **AT-14** | Restore and rollback: PITR restore to scratch; deploy N+1 then roll back to N | Ops drill (staging) | Restore within RTO; integrity queries clean; app rollback works with the migrated schema |
| **AT-15** | Excess capture after `PARTIALLY_REFUNDED` and after `REFUNDED` | Integration | Allocation `EXCESS`, automatic refund, order totals unchanged, `order.placed` not re-emitted (C04) |
| **AT-16** | Failed refund retried after a newer refund reused its capacity; then retried after capacity frees | API + integration | First retry 409 and refund stays FAILED; second retry creates attempt n+1 with a new `X-Refund-Idempotency` key and receipt; UNKNOWN outcomes resend the same key and body (C06 + provider stub) |
| **AT-17** | Redis loses an outbox job after `PUBLISHED`; a stale duplicate job also arrives | Integration (real Redis) | Delivery republished as next generation after timeout; effect once; delivery COMPLETED (C07) |
| **AT-18** | Webhook worker stalls past its lease, another worker reclaims and completes, the first resumes | Integration | Stale complete/fail/renew rejected; domain change once; event PROCESSED (C08) |
| **AT-19** | Multi-variant checkouts + releases + inventory imports + catalogue variant edits + taxonomy renames + search worker at concurrency ≥ 20 | Integration | No deadlocks (40P01); reservation/aggregate drift empty; search vectors current after the queue drains (C09) |
| **AT-20** | Same idempotency key + identical body reused against a different order (cancel, payment retry, refund, return); request A stalls past its lease, B takes over, A resumes | API | Cross-resource: 422 `IDEMPOTENCY_KEY_REUSED`. Takeover: one order/refund (resumed), A's mutations roll back and A gets 409 `REQUEST_SUPERSEDED`, later retries replay B; concurrent takeovers → one owner (C10) |
| **AT-21** | Role change and block with live storefront + admin sessions | API | Role change: admin session 401 on next request, storefront session keeps working; block: both 401 (C13) |
| **AT-22** | Webhook for a capture arrives before TX2 saves the provider order id; then TX2/reconciler saves it; webhook redelivery, verify and reconciler race | Integration (provider stub) | First call UNLINKED (no order effects); after mapping exactly one APPLIED, effects once, exception resolved; conflicting order/amount reports never attach; unmatched payments stay visible (C14) |
| **AT-23** | Payment first observed fully refunded / partially refunded; CAPTURED then REFUNDED; older CAPTURED after REFUNDED; concurrent observations | Integration (provider stub) | Fully refunded → VOID, no fulfilment, no second refund; partial → HELD + review, only remainder refundable; later/older observations side-effect free; unexplained provider refund → RECON_MISMATCH (C15) |
| **AT-24** | AUTHORIZED → provider voids/refunds → expiry; HELD/APPLIED payment refunded further in the Razorpay dashboard, then staff request a refund or retry a failed one | Integration (provider stub) | Order returns PROCESSING → UNPAID and expires once (stock and coupon released once); while provider refunds are unexplained, new refunds and retries get 409 `REFUND_RECONCILIATION_REQUIRED`; reconciliation records outside refunds once without double-counting ArtQ's own, then capacity reflects them (C16) |

Each row maps to database.md §8 and architecture.md §7–§8. Where a row cites a C-check, the **database-level** behaviour already has an executable check in `tools/doc-validation`. The AT itself (through HTTP, the services, Razorpay test mode and the browser) is **not implemented** until task 7.1.

---

## Post-launch backlog (prioritise after 4–6 weeks of data)
| Item | Est. |
|------|-----:|
| SMS/WhatsApp OTP (DLT) and phone login with mandatory OTP for phone change | 3 d |
| Courier API (Shiprocket): AWB, labels, tracking webhooks via inbox, live serviceability | 5 d |
| Product reviews & ratings | 4 d |
| Abandoned-cart reminders (consent-aware) | 2 d |
| Collections / curated pages | 1.5 d |
| Advanced reports (sales, GST exports, product performance) | 3 d |
| Split shipments (`shipment_items`) | 3 d |
| Bundles/kits, bulk pricing tiers | 7 d |
| Google sign-in | 1 d |
| Meta CAPI + Merchant Center feed | 2 d |
| Blog/tutorials | 3 d |
| PWA | 2 d |

## Client inputs (blocking)
| Input | Needed by | Blocks |
|-------|-----------|--------|
| Domain, logo SVG, sending domain (D-12) | Phase 0 | 0.8 |
| Razorpay test account (D-16) | Phase 4 start | 4.0 |
| COD, serviceability, courier, shipping values (D-4, D-6, D-7, D-13) | Phase 4 | 4.4 |
| Corrected catalogue data, photos, measured weights, physical counts (D-10, D-8, D-11) | Phase 5 | Publication, M4 |
| Accountant: HSN/GST, invoice timing/format, shipping-charge tax (D-1–D-3) | Phase 5 | 5.2, 7.5 |
| Return/RTO/coupon policies (D-5, D-9, D-14) | Phase 5 | 5.3–5.6 |
| Operations owner and escalation (D-15); Razorpay live KYC | Phase 7 | Launch |

## Definition of Done
1. PR reviewed, CI green (lint, types, unit, integration).
2. Tests added; money/stock/auth changes include a concurrency or failure-path test.
3. Mobile 360 px and desktop 1440 px; loading/empty/error/mutation states.
4. Accessible (keyboard, labels, contrast tokens only).
5. Permission-checked server-side and audited (admin).
6. Migration backward-compatible with the running version.
7. Deployed to staging and verified by someone other than the author.
8. Docs updated when behaviour, API or schema changes.
