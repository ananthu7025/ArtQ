# ArtQ: Delivery Plan & Task List

> Each task: ID, scope, ✅ acceptance criteria, estimate in **developer-days (d)**. Status `[ ]` todo · `[~]` doing · `[x]` done.
> Revised after the reliability/admin review ([review.md](review.md)). The previous plan was 94 d / "12–14 weeks". This one is re-estimated below.

## Assumptions
- Team: **1 senior full-stack lead + 1 frontend-leaning developer**; part-time designer and QA are **not** counted in dev-days.
- **Productive capacity:** 4 dev-days per developer per week (meetings, reviews, client calls, context switching), so **8 dev-days/week** for the team.
- Estimates include unit/integration tests for the task. The cross-cutting acceptance suite is task 7.1.
- Client inputs arrive on the dates in §Client inputs. Each week of delay on a blocking input moves the dependent milestone by the same amount.
- No application code exists yet (repository contains only these docs and the client files).

## Summary

| Phase | Name | Outcome | Dev-days |
|-------|------|---------|---------:|
| 0 | Foundations & compatibility | Node 24 toolchain proven, CI, environments, tokens | 7 |
| 1 | Core platform & security | Schema, customer auth, **admin MFA**, permissions, audit, outbox, inbox, idempotency, media | 17 |
| 2 | Catalogue & admin catalogue | Products page, editor, gate, import, inventory, all behind secure admin | 16 |
| 3 | Storefront browsing | Home, listing, PDP, search with correct caching | 13 |
| 4 | **Purchase flow** | Cart, coupons, shipping, checkout, Razorpay, COD, reconciliation | 19.5 |
| 5 | **Merchant operations** | Orders, fulfilment, invoices, cancellations, refunds, returns, COD, exceptions | 18 |
| 6 | Content, SEO, admin completeness | CMS, content pages, SEO, staff/settings/audit UIs | 7 |
| 7 | Hardening & launch | Acceptance suite, perf, security, a11y, restore drill, go-live | 12 |
| | **MVP total** | | **109.5** |
| | Contingency (15 %) | | **16.5** |
| | **Planned MVP effort** | | **≈ 126 dev-days** |

**Calendar duration:** 126 ÷ 8 dev-days/week ≈ **16 weeks** of build. With typical client-input waits (photos, counts, accountant approval, Razorpay live KYC), plan for **16–19 weeks** from kickoff to launch. Dev-days measure effort; weeks are calendar time with two people working in parallel.

**Why it changed (126 d vs. the previous 94 d, +32 d):**
- **+15.5 d of MVP scope (109.5 vs 94).** New reliability and security work adds about 24.5 d: admin MFA and session rotation, payment attempts and the recovery matrix, reconciliation, durable webhook inbox, transactional outbox, idempotency, reservation-based inventory, coupon reservation, refunds with item allocation, credit notes, COD remittance/RTO, the returns workflow, the publication gate, import row outcomes/resume, private media, SSRF-safe fetching, exception and jobs views, the promotion pipeline, the restore drill and the acceptance suite.
- **−9 d moved out of the MVP:** collections, abandoned carts, advanced reports, reviews and SMS go to the post-launch backlog.
- **+16.5 d contingency (15 %).** The previous plan had none.

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

## Phase 0: Foundations & compatibility (7 d)
- [ ] **0.1 Compatibility spike + monorepo** (1.5 d): pnpm + Turborepo; `apps/web` (Next.js), `apps/admin` (Vite), `apps/api` (Express), `packages/{shared,ui,config}`; `.nvmrc` 24, `engines` `>=24.11 <25`. Smoke-test on Node 24: Next build, Vite build, Prisma 6.19 generate + migrate, sharp, argon2, BullMQ/ioredis, exceljs, @react-pdf/renderer, otplib; evaluate Prisma 7.
  ✅ `pnpm build && pnpm test` green on Node 24 in CI; pinned versions recorded in review.md §4; any incompatibility has a documented substitute.
- [ ] **0.2 Code quality** (0.5 d): ESLint, Prettier, strict TS, Husky, commitlint; a lint rule/CI grep forbidding `app/api/**` and `"use server"` in `apps/web`.
  ✅ CI fails if Next.js gains backend code.
- [ ] **0.3 Local infrastructure** (0.5 d): docker-compose (Postgres 16+, Redis 7 AOF, MinIO with public+private buckets, Mailpit); `.env.example`.
  ✅ Fresh clone → running stack in < 15 min.
- [ ] **0.4 API skeleton** (1 d): middleware chain (architecture.md §4) incl. origin guard stub, JSON-only enforcement, strict zod, error format, `/health`, `/health/ready`.
  ✅ Form-encoded POST → 415; unknown body key → 400.
- [ ] **0.5 Worker skeleton** (0.5 d): BullMQ queues, repeatable schedulers registered at start, Bull Board (admin-only later).
  ✅ Scheduler re-registers after worker restart.
- [ ] **0.6 Design tokens & primitives** (1.5 d): tokens from design-system.md (accessible `brand-700` action colour), primitives, **contrast unit test** over the token pairs in design-system.md §2.3.
  ✅ Test fails if any text pair < 4.5:1 or UI boundary < 3:1.
- [ ] **0.7 CI** (0.5 d): lint → typecheck → unit → integration with Testcontainers (Postgres, Redis) → build; migration check (fails on destructive SQL without an `-- contract-phase` marker).
  ✅ Required checks on `main`.
- [ ] **0.8 Environments & promotion** (1 d): staging + production projects with isolated DB/Redis/R2/secrets; API image built once per SHA, deployed to staging, promoted by digest to prod after approval; Vercel promote; Sentry.
  ✅ Promotion of the same digest demonstrated; staging cannot reach prod resources.

## Phase 1: Core platform & security (17 d)
- [ ] **1.1 Schema & migrations** (2 d): database.md §5 + database.md §6 as `0001_init` + `0002_constraints_search_integrity`.
  ✅ Applies on empty DB; constraint tests (publish gate, refund cap, snapshot/invoice immutability, coupon capacity, category/type FK) pass.
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
- [ ] **1.8 Outbox + email consumer** (1.5 d): writer helper (same TX), dispatcher (`SKIP LOCKED`, jobId dedupe, NOTIFY wake-up), `processed_messages`, email consumer with `email_logs` dedupe and provider idempotency key.
  ✅ Kill dispatcher between enqueue and commit → no duplicate email; outbox DEAD → exception.
- [ ] **1.9 Webhook inbox framework** (1 d): signature verify, durable insert, ack-after-commit, claim/lock, retry/backoff, DEAD, sweeper.
  ✅ AT-04 passes on a synthetic provider.
- [ ] **1.10 Idempotency middleware** (1 d): scope/operation/key, request hash, PROCESSING lock, replay, conflict, takeover after lock expiry, 24 h purge.
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

## Phase 4: Purchase flow (19.5 d) → **M2**
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
- [ ] **4.9 Webhooks, reconciliation, expiry, late/excess captures** (2.5 d): Razorpay handlers on the inbox, reconcile-attempts, expire-pending with pre-check, daily reconciliation, exceptions creation.
  ✅ AT-04, AT-05, AT-06, AT-07 pass.
- [ ] **4.10 Order notifications & confirmation** (1 d): outbox events → emails, success/processing pages, analytics `purchase` once.
- [ ] **M2 demo** on staging.

## Phase 5: Merchant operations (18 d) → **M3**
- [ ] **5.1 Admin Orders** (2.5 d): list filters (4 dimensions + exceptions), detail, transitions, packing slip, address correction, resend email.
- [ ] **5.2 Dispatch & invoices** (2 d): consume reservations, shipment (single), invoice numbering + immutable snapshot + PDF render (private).
  ✅ Invoice sequence gap-free under 20 concurrent dispatches.
- [ ] **5.3 Cancellation** (1.5 d): customer/admin, release, automatic refund for prepaid, coupon reversal policy.
- [ ] **5.4 Refunds** (3 d): refundable calculator, item allocation, capacity under lock, provider send/unknown/failed, webhook + reconcile, manual COD refunds, credit notes.
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

## Phase 7: Hardening & launch (12 d) → **M4**
- [ ] **7.1 Acceptance suite** (4 d): implement AT-01…AT-14 (below) in CI (integration with Testcontainers + Playwright on staging).
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
| **AT-05** | Duplicate and out-of-order webhooks: `captured` ×3 then a late `authorized`; refund events reversed | Integration | One payment row, rank stays CAPTURED; refund ends PROCESSED; one email per event key |
| **AT-06** | Multiple distinct captures for one order (two attempts both paid) | Integration | First APPLIED; second EXCESS + exception + automatic refund; `captured_amount` = order total |
| **AT-07** | Capture racing expiry and cancellation | Integration | Before expiry → order placed, not expired; after expiry with stock → restored; after expiry without stock → refunded + exception; after cancellation → refunded, never revived |
| **AT-08** | Concurrent refunds: 3 staff refund ₹700 each on a ₹1,000 capture; per-item bound | Integration | Exactly one accepted; others 409; sums never exceed captured or item net |
| **AT-09** | Concurrent final coupon use: 10 checkouts with a limit-1 coupon | Integration | One RESERVED; others 422; expiry releases without touching `redeemed_count` |
| **AT-10** | STAFF attempting price changes via inventory, variant, bulk and import endpoints | API | All rejected (403/400 unknown key); audit records attempts; prices unchanged |
| **AT-11** | Refresh across reloads and multiple tabs: 3 tabs, reload, concurrent refresh, stolen-token replay | Playwright + API | No logout on concurrent refresh (grace); replay after grace revokes session; logout propagates to all tabs |
| **AT-12** | Guest order and attachment access isolation | API + Playwright | Tracking link read-only; actions need email OTP; cookie scoped to one order; other orders'/users' attachments → 404/403; presigned URLs expire |
| **AT-13** | Imports during reservations: inventory import sets on_hand while 3 orders hold reservations; catalogue re-import | Integration | `reserved` unchanged; available recalculated; count < reserved raises OVERSOLD; catalogue import changes no stock |
| **AT-14** | Restore and rollback: PITR restore to scratch; deploy N+1 then roll back to N | Ops drill (staging) | Restore within RTO; integrity queries clean; app rollback works with the migrated schema |

Each row maps to the reference SQL in database.md §8 and the flows in architecture.md §7 and architecture.md §8.

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
