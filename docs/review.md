# ArtQ: Architecture Reviews

Two senior architecture/solution reviews of the planning documents, with the resulting changes. Use this file to see **what changed, why, where, and what has actually been executed**.

| Review | Baseline | Sections |
|--------|----------|----------|
| 1 | `fe85b89` (initial docs) | §1–§2 (matrix), §4 (historical validation) |
| 2 | `ea660fa` (after review 1) | §5 (findings, verification, matrix), §6 (reproducible validation) |
| 3 | `8fe33f4` (after review 2) | §9 (payment recovery, refunded-first payments, idempotency fencing) |
| Both | | §3 scope & estimates, §7 limitations, §8 open decisions |

Legend for every matrix: **Doc** = documentation correction; **Exec** = covered by an executable check in `tools/doc-validation` (database layer only); **App** = application behaviour that does not exist yet and is covered by a planned acceptance test.

## 1. Review 1: repository state
- `main` at `fe85b89`: `README.md`, `docs/*.md` (7 documents), `ArtQ Site Ref.png`, `ArtQ_Product_Import_All_Items.xlsx`, `.claude/settings.json`. **No application code** exists, so every finding below is a **design/documentation fix**. No runtime bug has been "fixed", because there is no runtime yet.
- The GitHub repository is **public** and contains the client's product spreadsheet and site screenshot. Recommendation (owner decision): make the repository private or remove the client files from history.
- The admin screenshot referenced in the review brief was **not available** to the reviewer (not attached, not in the repo). Admin requirements were derived from the brief's explicit list of visible modules and Products-page features; no other modules were inferred.

## 2. Review 1: issue-to-fix matrix
> Section references are as of `ea660fa`. Review 2 refined rows 1.4, 2.1, 2.5, 2.6, 3.1–3.3, 4.1, 4.4, 5.1, 6.4 and 7.4 (see §5); database.md §8 was renumbered.

Legend: A = architecture.md, D = database.md, P = product.md, API = api.md, DS = design-system.md, C = catalog.md, T = tasklist.md.

### 2.1 Authentication & authorization
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 1.1 | Refresh cookie `Path=/auth` never sent to `/v1/auth/refresh` | `Path=/v1/auth` (admin `/v1/admin/auth`), shared helper sets & clears with identical attributes | A §5.1, API §1 |
| 1.2 | `Domain=.artq.in` cookies shared across hosts/environments | Host-only `__Secure-` cookies; per-env issuer, keys, names; staging on separate hosts | A §5.1, §12 |
| 1.3 | Rotation/reuse rules undefined; tab races would trigger false reuse | Token history table, 30 s grace returning access token only, reuse ⇒ session revoke; Web Locks + BroadcastChannel coordination | A §5.2–5.3, D §3.1 |
| 1.4 | Blocking a user / role change didn't revoke access until token expiry | `auth_version`, session revocation, Redis session-state check per request | A §5.4 |
| 1.5 | CORS treated as protection; no CSRF defence for cookie endpoints | SameSite=Strict + Origin/Sec-Fetch-Site guard + JSON-only; CORS explicitly not authorization | A §5.5, API §1 |
| 1.6 | Admin "optional TOTP" with tokens issued before MFA | Mandatory MFA for all staff; challenge before any token; enrolment, recovery codes, encrypted secret, replay guard, step-up, break-glass | A §5.8, API §4.1, D §3.1 |
| 1.7 | STAFF could change prices via `PATCH /admin/variants/:id` | Split `inventory:adjust` / `catalog:write` / `pricing:write` / `catalog:publish`; strict per-permission schemas | A §5.9, API §4.3, §4.5 |
| 1.8 | Phone was a login identifier with unverified changes | Launch: phone is contact-only (not unique, no login); post-launch phone change requires OTP | A §5.7, P §5.9 |
| 1.9 | Guest checkout created "guest users"; unverified emails linked orders | No guest user rows; contact unverified; tracking token + email-OTP order access; linking only on verified email; conflict rules | A §5.6, D §3.1/3.9, API §3.6 |
| 1.10 | Phone OTP specified while SMS deferred | Launch OTP email-only; SMS in the post-launch backlog | A §5.7, T backlog |

### 2.2 Checkout & payments
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 2.1 | Signature treated as proof of capture | Verify signature with the **stored** provider order id, then fetch the payment and check status = captured, amount, currency, order binding | A §7.1–7.2, API §3.8 |
| 2.2 | No authorized/processing state | `PROCESSING` payment status, polling endpoint, stuck-authorized capture rule | D §4.4, P §5.6 |
| 2.3 | Provider call before persisting; failures unrecoverable | `payment_attempts` row (`receipt`) before calling Razorpay; recovery matrix for create failure, timeout, crash, repeats, unknown status | A §7.3, D §3.10, §8.1–8.2 |
| 2.4 | DB transaction around external calls | Rule: no network call inside a TX; TX1/TX2 split | D §1, A §7.1 |
| 2.5 | Idempotency only mentioned as a header | `idempotency_keys` (scope, operation, key, hash, state, resource, response replay, 24 h, conflict 422, takeover); also payment retry, cancel, refund, return | API §1.2, D §3.10 |
| 2.6 | Duplicate notification vs second capture not distinguished | Unique payment id + monotonic rank vs `EXCESS` allocation with exception + auto refund | D §4.6, §8.3 |
| 2.7 | Late capture after expiry/cancellation under-specified | Reacquire stock or refund; cancelled never revived; customer messages; transition tables aligned | D §4.2, §4.6, P §8.6 |

### 2.3 Webhooks & jobs
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 3.1 | "Insert event, skip duplicates" loses events that fail after insert | Durable inbox: states, attempts, backoff, DEAD, locks, sweeper, ack-after-commit, duplicate re-enqueue, fetch-then-apply ordering | A §8.1, D §3.11, §8.7 |
| 3.2 | Side effects enqueued after commit could be lost | Transactional outbox in the same TX + dispatcher with jobId dedupe | A §8.2, D §8.8 |
| 3.3 | Implied exactly-once emails | At-least-once with `email_logs` dedupe + provider idempotency key; consumer `processed_messages` | A §8.3 |
| 3.4 | No reconciliation or visibility | Attempt/refund/daily reconciliation jobs; `payment_exceptions`; admin Payment Exceptions and Jobs & Webhooks views; alerts | A §7.4, §13, P §7.5 |

### 2.4 Inventory & coupons
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 4.1 | Single `stock` field decremented at checkout; imports could overwrite | `on_hand`, `reserved`, available; reservation rows ACTIVE/CONSUMED/RELEASED; event table; lock order | D §3.5, §4.1, §8.1/8.4/8.5 |
| 4.2 | `allow_backorder` contradicted "never negative" | Backorders removed from v1 | D §3.3, P §1.2 |
| 4.3 | Recounts/imports vs reservations undefined | On-hand-only adjustments; OVERSOLD exception; catalogue import never touches existing stock | D §3.5, §9 |
| 4.4 | Coupon `used_count` decremented on expiry; no atomic capacity | `reserved_count`/`redeemed_count` with DB capacity check; RESERVED/REDEEMED/RELEASED/REVERSED; over-limit late captures | D §3.7, §8.1, P §8.4 |
| 4.5 | Aggregates drift risk | Same-TX maintenance + drift views + nightly check | D §7 |

### 2.5 Refunds, returns, fulfilment, invoices
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 5.1 | Refund total not enforced atomically | Capacity under payment-row lock incl. pending/unknown; DB check on order | D §8.6, §6 |
| 5.2 | No item-level allocation / fee treatment | `refund_items`; shipping/COD-fee rules | D §3.10, §4.5, P §8.6 |
| 5.3 | Returns not linked to refunds; quantities unbounded; restock on approval | Return → refund link; quantity checks; approve ≠ receive ≠ inspect; restock sellable only | D §3.12, A §10.3 |
| 5.4 | One combined order status | Four dimensions: lifecycle, payment, fulfilment, return | D §3.9, §4 |
| 5.5 | COD remittance, RTO, lost undefined | COD states + remittance tables; RTO/lost flows | D §3.12, A §10.1, §10.5 |
| 5.6 | Split shipments ambiguous | v1 = single shipment (`UNIQUE(order_id)`); split is post-launch | D §3.12 |
| 5.7 | Invoices assigned at payment, mutable, no credit notes | Immutable invoice snapshots at dispatch, ≤ 16-char FY numbering, rounding rule, credit notes, accountant approval | D §3.12, §4.4, A §10.4 |

### 2.6 Shipping & catalogue
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 6.1 | PRD charged heavy orders > 10 kg; pricing function made them free | One algorithm (slabs, extra kg, threshold after discount, heavy cap, FREE_SHIPPING coupon, COD fee separate) + worked example | A §6.5, P §8.2 |
| 6.2 | Pincode existence treated as serviceable | `postal_codes` (geography) vs `pincode_serviceability` (delivery/COD/surface) | D §3.2, API §3.1–3.2 |
| 6.3 | No volumetric/bulky/resin handling | Volumetric weight, packaging, shipping classes, surface-only resin (D-7) | A §6.5 |
| 6.4 | Guessed data could become sellable | Publication gate + DRAFT default + data flags; DB check | P §8.7, D §6, C §6 |

### 2.7 Schema, search, media, caching
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 7.1 | **Embedded Prisma schema was invalid** (single-line enums; 123 validator errors) | Rewritten schema validated with Prisma 6.19.3 | D §5, §4 below |
| 7.2 | Missing FKs (media, etc.) and history-destroying deletes | FKs with `RESTRICT` for history; soft deletes; composite category/type FK | D §1, §5, §6 |
| 7.3 | Missing quantity/money/refund/reservation checks | Checks in `0002` | D §6 |
| 7.4 | Search vector stale on variant/category/type changes | Triggers on all four tables | D §6 |
| 7.5 | Filters could match different variants | Same-variant `EXISTS` semantics | A §6.2, API §3.3 |
| 7.6 | Import mixed catalogue and stock; no row outcomes/resume/concurrency | CATALOG vs INVENTORY kinds; row table, outcomes, resume, `NEEDS_REVIEW` on version conflict | D §9 |
| 7.7 | Upload validation, private files, SSRF | Presign constraints, HEAD + sniff + decode, ownership, private bucket, SSRF-safe fetcher | A §9 |
| 7.8 | Caching layers & staleness undefined; risk of caching personal data | Allow-listed public caching, ≤ ~3 min staleness, explicit no-store list | A §6.1 |

### 2.8 Admin panel
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 8.1 | Screenshot modules (Dashboard, Orders, Customers, Coupons, Shipping Rates, Products, Restock Requests, Product Types, Categories, Techniques) not consistently specified | Navigation, permissions, API contracts, DB support, tasks for each | P §7.2, API §4, A §5.9, T Phases 2/4/5 |
| 8.2 | Products page capabilities | Preserved screenshot features + commerce extensions | P §7.3, API §4.3, DS §6.5 |
| 8.3 | Visible issues: type "Unknown", missing images, sidebar cut off, teal contrast | DTO/relation + Unassigned state; image states + fallbacks + gate; scrollable sidebar/drawer + E2E; contrast tokens | P §7.3, DS §2.3, §6.4–6.5, T 2.1/2.4 |
| 8.4 | Operational modules missing | Inventory, Returns & Refunds, COD Remittances, Media, Imports, CMS, Staff, Settings, Audit, Payment Exceptions, Jobs & Webhooks; advanced reports/marketing post-launch | P §7.2/7.5 |

### 2.9 Delivery & design system
| # | Issue | Fix | Where |
|---|-------|-----|-------|
| 9.1 | Node 20 baseline (EOL April 2026) | Node 24 LTS + compatibility spike | A §2, T 0.1 |
| 9.2 | White on `#00a99d` = 2.93:1 for small labels | `brand-700 #00756f` (5.56:1) action colour; measured contrast table; CI contrast test | DS §2 |
| 9.3 | No promotion, migration or rollback policy | Same-digest promotion, expand/contract, rollback by image, flags | A §12 |
| 9.4 | No RPO/RTO, alerts or ownership | RPO ≤ 5 min, RTO ≤ 4 h, drills, alert table, owners | A §13 |
| 9.5 | Catalogue mutations before secure admin auth | Admin MFA in Phase 1; catalogue admin in Phase 2 | T |
| 9.6 | Milestones not organised around purchase/operations; estimates optimistic | M2 working purchase, M3 merchant operations; 109.5 d + 15 % = 126 d ≈ 16–19 weeks; assumptions stated | T |

### 2.10 Validation
| # | Requirement | Where |
|---|-------------|-------|
| 10.1 | 14 required acceptance scenarios | T Acceptance tests (AT-01…AT-14) |

## 3. Scope & estimates (current)
- **MVP:** storefront, accounts (email), guest checkout, Razorpay + COD, reconciliation, refunds/returns/credit notes, inventory reservations, coupons, shipping rules, full admin including the screenshot modules and the operations views, CMS, SEO.
- **Post-launch:** SMS/WhatsApp + phone login, courier API, reviews, abandoned carts, collections, advanced reports, split shipments, bundles, loyalty, PWA.
- **Effort:** 114 dev-days of MVP scope + 17 contingency = **131 dev-days**; **17–20 calendar weeks** for two developers at 8 dev-days/week. The baseline stays **94** dev-days (tasklist.md explains the derivation); review 3 added +1 d (tasks 1.10 and 4.9).

## 4. Review 1 validation (historical: PostgreSQL 18 only, ad-hoc scripts; superseded by §6)

### 4.1 Checks executed then (documentation artifacts, not application tests)
| Check | Method | Result |
|-------|--------|--------|
| Previous embedded Prisma schema | `prisma validate` (6.19.3) on the schema extracted from `git show HEAD:docs/database.md` | **Invalid** (123 error lines: single-line enums) |
| New embedded Prisma schema | Extracted **from the updated database.md**, `prisma validate` | Valid |
| Initial DDL | `prisma migrate diff --from-empty` → applied to a scratch **PostgreSQL 18** cluster | 72 tables created |
| Integrity migration (database.md §6) | Extracted from the doc, applied after the DDL | Applied without error |
| Concurrent stock reservation (§8.1 SQL) | 20 parallel single-unit reservations, `on_hand = 5` | 5 succeeded, `reserved = 5` |
| Concurrent final coupon use (§8.1 SQL) | 10 parallel reservations, limit 1 | 1 succeeded; capacity CHECK rejects over-limit counters |
| Concurrent refunds (§8.6 SQL) | 3 parallel ₹700 refunds on ₹1,000 capture | 1 refund row inserted |
| Order refund cap, publish gate, category↔type FK, order-item snapshot immutability, return-qty bound, invoice immutability (update + delete) | Direct statements | All rejected by the intended constraint/trigger |
| Search triggers | Variant insert and category rename | Search vector updated (variant colour, SKU, new category name match) |
| Drift views | Aggregates unset → rebuild; reserved without reservation rows | Drift detected, cleared after rebuild; reservation drift detected |
| Webhook inbox (§8.7 SQL) | Duplicate insert; 4 concurrent claims; expired-lock reclaim | No duplicate; 1 winner; reclaim succeeded |
| Idempotency & one open attempt per order | Duplicate key insert; two open attempts | Rejected by unique indexes |
| Colour contrast | WCAG relative-luminance computation for every token pair in design-system.md §2.3 | Values as listed; failing pairs restricted to decorative use |
| Cross-document consistency | Searched all docs for superseded terms (`Path=/auth`, guest users, backorder, `used_count`, Node 20, phone login, Phase 9, single `stock`, combined statuses) and reconciled cookie paths, transitions, settings keys, permissions, decision IDs | Remaining mentions are intentional (describing what was replaced) |

Validation environment: macOS, Node v24.14.0, Prisma 6.19.3, PostgreSQL 18 (local scratch cluster, deleted after use).

### 4.2 Not executed then
- **No application tests exist or were run**; there is no code. AT-01…AT-14 (tasklist.md) are specified and become CI gates during implementation.
- Razorpay API capabilities assumed in architecture.md §7 (fetch order by receipt, list payments of an order, refund receipts, event-id header, late authorization) were **not verified** against a live/test account. Task 4.0 verifies them.
- Prisma 7 compatibility, the Next.js/sharp/argon2 Node 24 build and email-provider idempotency support are verified in task 0.1.
- GST rates/HSN codes and invoice rules need accountant confirmation (D-1–D-3).

## 5. Review 2 (baseline `ea660fa`)

### 5.1 Repository state
- `main` = `ea660fa` = the reviewed baseline; clean working tree. Still **no application code**. Changes in this review are uncommitted on `main` (not pushed, merged or deployed).
- New: `tools/doc-validation/` (package with pinned tools, extractor, runner, checks C00–C13).
- Each finding was checked against the files before changing anything. Results are below.

### 5.2 Findings: verification and fixes

| # | Finding | Verified against `ea660fa` | Fix | Where | Type |
|---|---------|---------------------------|-----|-------|------|
| 1 | Payment side effects not gated | **Confirmed.** D §8.3 gated only the payment upsert. Coupon counters, sold counts, cart, history and outbox ran unconditionally, and "excess" was keyed on `payment_status = PAID`, which is false after a refund | `aq_apply_provider_payment`: bind via stored attempt → order lock → monotonic upsert → **allocation set once (gate)** → per-branch side effects, each gated by its own affected-row check. EXCESS = "another APPLIED payment exists", so it holds after partial/full refunds. Late capture after expiry/cancellation per policy. Verify, webhook and reconciler call this one function | D §3.10, §4.6, §6b, §8.2; A §7; API §3.8 | Doc + Exec (C03, C04) |
| 2 | BullMQ job ids with `:` | **Confirmed.** `wh:<id>` (2 parts) is rejected by BullMQ 5.81.5 and 6.3.11 ("Custom Id cannot contain :"). `outbox:<id>:<consumer>` is accepted only through a legacy 3-part carve-out | `wh-<id>`, `outbox-<deliveryId>-<generation>` | A §8; D §8.6–8.7 | Doc + Exec (C02) |
| 3 | Refund idempotency relied on `receipt` | **Confirmed.** The old receipt-only design gave no protection against a resend after a timeout. Razorpay documents `X-Refund-Idempotency` (≥10 chars, `[A-Za-z0-9_-]`), same key + identical body on retry, a conflict for a different body or an in-flight request, and `receipt` as an optional field it also treats as a duplicate guard | `refund_attempts` with persisted key, receipt and immutable request; same key + body on resend; new attempt (new key + receipt) only after a definitive failure; outcome table for timeout, in-progress, mismatch, unknown. Order creation (receipt lookup) and capture (re-fetch) recovery are defined separately | D §3.10, §6b; A §7.3, §7.4, §10.2; API §4.7 | Doc + Exec (C06 for the DB side); provider behaviour App (task 4.0, AT-16) |
| 4 | Item capacity used processed amounts only | **Confirmed.** The item check compared against `refunded_amount`, so pending refunds were not counted; there were no shipping/COD-fee limits, no retry path and no COD equivalent | Reserved counters at item, shipping, COD-fee, order and payment level; counted statuses REQUESTED/PENDING/UNKNOWN/PROCESSED; FAILED releases; atomic retry reacquisition; COD manual refunds with the same counters; manual cancel only for COD | D §3.10, §4.5, §6, §6b, §8.5; API §4.7; P §8.6; T 5.4 | Doc + Exec (C05, C06) |
| 5 | Outbox dispatcher held locks while publishing to Redis | **Confirmed.** D §8.8 called `queue.add` between `FOR UPDATE SKIP LOCKED` and `COMMIT` | `outbox_deliveries` per consumer; claim (short TX, lease token, generation) → publish outside TX → fenced ack; PUBLISHED ≠ COMPLETED; redelivery after timeout; dead after 10 generations; consumer dedupe on the delivery row; retention | D §3.11, §6b, §8.7; A §1.2, §8.2–8.4, §13 | Doc + Exec (C07 with real Redis loss) |
| 6 | Trigger locks broke the lock order | **Confirmed empirically.** The variant trigger updated the parent product inside the variant loop. Negative control: 43–74 deadlocks per 600 mixed operations across runs. Two further real defects surfaced while fixing this: explicit `FOR UPDATE` locks conflicting with FK key-share locks (149 deadlocks), and a non-deterministic search vector (`string_agg` without `ORDER BY`) that made drift checks report false mismatches | Triggers never lock other tables' rows (BEFORE trigger on the product's own columns + append-only reindex queue); global lock order covering all flows; `FOR NO KEY UPDATE` everywhere; search worker locks first, then computes | D §1, §4.1, §6, §6b, §7; A §6.3 | Doc + Exec (C09) |
| 7 | Idempotency fingerprint lacked target | **Confirmed.** The hash covered the body only | Fingerprint = {operation, target, scope, body}; `target_resource` column; target mismatch is always CONFLICT | D §3.10, §6b; API §1.2 | Doc + Exec (C10) |
| 8 | Global `auth_version` contradiction | **Confirmed.** A role change incremented the global version, which also invalidated storefront sessions despite the text | Separate `storefront_auth_version` / `admin_auth_version`; `aq_session_valid`, `aq_change_role`, `aq_revoke_all_sessions`; cache invalidation on every change | D §3.1, §6b; A §5.2, §5.4 | Doc + Exec (C13); HTTP layer App (AT-21) |
| 9 | Webhook leases not fenced | **Confirmed.** Success/failure updates matched on id only | `lease_token`; fenced claim/begin/renew/complete/fail; completion in the same TX as the domain change (raises ⇒ rollback) | D §3.11, §6b, §8.6; A §8.1 | Doc + Exec (C08) |
| 10a | Partial dimensions passed | **Confirmed.** `(all NULL) OR (l>0 AND w>0 AND h>0)` evaluates to NULL (passes) when only some are set | All absent, or all present and positive | D §6 | Doc + Exec (C11) |
| 10b | Inspection quantities | **Confirmed.** `-1 + 3 = 2` was accepted; no completeness check before INSPECTED | Individually bounded, paired, summing; finalisation trigger | D §3.12, §6 | Doc + Exec (C11) |
| 10c | Refund lock sequence | **Confirmed.** The refund SQL locked the payment without the order lock | Order → payment → order-owned rows in every refund function | D §4.1, §6b | Doc + Exec (C05, C06) |
| 10d | Publication readiness overstated | **Confirmed.** The DB check trusted `is_publishable` | `products_publish_gate_trg` recomputes readiness from images, variants and tax data on every transition to ACTIVE; post-publish changes are guarded by the service and detected by `published_not_ready`; explicit service-vs-DB table | D §3.3, §6 | Doc + Exec (C12) |
| 11a | "Maximum" staleness | **Confirmed.** No maximum is enforced | Normal-case ≈ 3 min, no hard maximum; outage behaviour (stale HTML served, live availability/cart/checkout fail closed) | A §6.1 | Doc |
| 11b | Baseline 94 → 104 | **Not confirmed.** At `fe85b89` the phase table and the 69 task estimates both sum to **94** (6+12+11+15+8+14+11+8+9); the header said "≈ 95–110". No 104 figure exists in the history | Kept 94 and documented the derivation; recalculated all totals (113 MVP + 17 = 130 at review 2; 114 + 17 = 131 after review 3) | T | Doc |
| 12 | Validation not reproducible; PG version unpinned | **Confirmed.** Review 1 ran ad-hoc scripts on PostgreSQL 18 while deployment said "16+" | Pinned PostgreSQL 16 for every environment; committed validator; matrix run 16.14 (required) + 18.3 (informational) | A §2, §12; D header; T 0.3, 0.9; `tools/doc-validation` | Exec |

### 5.3 Other changes made while fixing the above
- UUID primary keys now use `dbgenerated("gen_random_uuid()")`. Prisma's client-side `uuid()` left SQL-created rows without ids (found by C13).
- `processed_messages` removed: the delivery row is the durable dedupe record.
- `refunds.receipt` moved to `refund_attempts` (one receipt per attempt, because Razorpay rejects a reused receipt).
- Order-level refund statuses gained `CANCELLED` (manual COD refunds only); `payments.allocation` gained `LATE` and `HELD` and is nullable until decided.
- Paid-order cancellation now has explicit gating for the coupon reversal (D §4.2).
- Dispatch (D §8.4) is still service SQL, not a function. Task 5.2 converts it and adds a check.

## 6. Review 2 validation (reproducible)

**How to reproduce:** `cd tools/doc-validation && npm ci && npm run validate` (PostgreSQL 16.14 via the pinned `embedded-postgres` binaries, plus `redis-server` on PATH). For the forward-compatibility run: `PG_BIN_DIR=<pg18>/bin npm run validate`.

**Environment of the recorded run:** macOS arm64, Node v24.14.0, Prisma 6.19.3, BullMQ 5.81.5 (+ 6.3.11 for comparison), pg 8.16.3, Redis 8.6.2.

| Check | What it executes | PG 16.14 | PG 18.3 | Result detail (16.14 run) |
|-------|------------------|:--:|:--:|------|
| C00 | Prisma validate + DDL from the schema extracted from database.md | PASS | PASS | 74 tables |
| C01 | 0001 + 0002 + 0003 extracted from database.md | PASS | PASS | applied |
| C02 | BullMQ job ids on a real Redis | PASS | PASS | `wh:42` rejected by 5.81.5 and 6.3.11; hyphen ids accepted; duplicate `jobId` ignored |
| C03 | Same capture via verify + webhook + reconciler (3 concurrent + 2 later, incl. an older `authorized`) | PASS | PASS | 1 APPLIED, 4 DUPLICATE; coupon (reserved 0, redeemed 1); sold 3; 1 history row; 1 event; 3 deliveries |
| C04 | Excess after partial and full refund; late capture (expired ± stock, cancelled); amount mismatch | PASS | PASS | EXCESS ×2 with automatic refunds, `order.placed` once; expired+stock → APPLIED; expired−stock → LATE; cancelled → LATE; mismatch → HELD |
| C05 | 8 concurrent refunds on one item, 6 on shipping, 5 COD manual; manual cancel | PASS | PASS | 1 / 1 / 1 accepted; loser error `REFUND_EXCEEDS_CAPACITY:item`; cancel releases once; online refund not cancellable |
| C06 | Failed refund retried after capacity reuse; per-attempt keys; stale results; concurrent retries | PASS | PASS | retry blocked while capacity used; attempt 2 key `artq-refund-1-a2`; stale result ignored; 4 concurrent retries → 1 |
| C07 | Outbox: publish, **FLUSHALL Redis**, redeliver, stale duplicate job, fencing, dead | PASS | PASS | redelivered as generation 2; effect once; stale ack rejected; DEAD + exception |
| C08 | Webhook: worker A stalls, B reclaims and completes, A resumes | PASS | PASS | A fenced at begin/complete/fail/renew; one `order.placed` |
| C09 | 1,200 mixed multi-variant ops at concurrency 24 + negative control | PASS | PASS | 0 deadlocks, all drift/negative/stale-search/queue counts 0; old trigger: 43–74 deadlocks per 600 ops across runs |
| C10 | Cross-resource key reuse for refund/cancel/retry/return; replay; takeover; 10 concurrent | PASS | PASS | CONFLICT (also with an identical hash); `{"NEW":1,"IN_PROGRESS":9}` |
| C11 | Partial dims; inspection quantities; finalisation | PASS | PASS | all invalid combinations rejected; the old expressions are shown to have accepted them |
| C12 | Publish gate trigger; final unit; final coupon use; invoice/order-item immutability | PASS | PASS | gate lists failing checks; PROCESSING image rejected; drift view catches post-publish breakage; 5 of 12; 1 of 10 |
| C13 | Audience-specific auth versions | PASS | PASS | role change keeps storefront, kills admin; block kills both |

Stability: C03, C05, C07 and C09 were re-run three more times on 16.14, all PASS; after the deterministic-order fix, C09 alone passed **25/25** consecutive runs, followed by a final full run of all checks on 16.14 and 18.3 (all PASS). Result files are written to `tools/doc-validation/.tmp/results-<version>.json` (git-ignored).

**Iterations during this review (the checks found real defects in the first drafts):** C09 initially failed with 149 deadlocks (`FOR UPDATE` vs FK key-share), then intermittently with "stale" search vectors. The reproduced cause was **non-deterministic term order** (`string_agg` over variants without `ORDER BY`), not stale content; fixed with `ORDER BY id`. The search worker's lock-then-compute step, added first on the theory of snapshot reuse after a lock wait, is kept as a defensive measure, but no check demonstrates that race; C10 with a return-type mismatch; C13 with missing DB-side UUID defaults; C04/C03 failures were test-fixture mistakes. All were fixed in the documented SQL, not by weakening checks.

## 7. Limitations: what is still unverified or unimplemented
- **No application exists.** Nothing here shows that future TypeScript services, HTTP middleware (cookies, CSRF/Origin, rate limits), the admin UI or the storefront behave as specified. Those are AT-01…AT-23 (tasklist.md), all **unimplemented**.
- **Provider behaviour is simulated.** The checks pass provider results into the functions. Not verified against a Razorpay test account (task 4.0): order lookup by `receipt`; exact refund-idempotency status codes (409 vs 400) and error bodies; idempotency-key retention period; late authorization; webhook event-id header; capture "already captured" error shape.
- **Email provider idempotency** support is assumed per provider choice (task 0.1); without it, duplicate emails are possible after a crash.
- **Dispatch / invoice issue**, paid-order cancellation, RTO and return-receipt restocking are specified as service SQL but have **no executable check yet** (tasks 5.2–5.6).
- **Performance** is not validated (C09 shows deadlock freedom at moderate concurrency, not throughput).
- The **admin screenshot** has still not been provided to the reviewer; admin requirements rely on the listed modules and features.
- The repository is **public** and contains client files (owner decision).

## 8. Open decisions
Business inputs only; the full list with defaults and deadlines is in [product.md §11](product.md#11-open-decisions-business-inputs-only): D-1 tax classification · D-2 invoice timing/format · D-3 tax on shipping/COD fee · D-4 COD parameters · D-5 return policy · D-6 serviceability policy · D-7 courier & resin carriage · D-8 large resin packs · D-9 prepaid RTO refund · D-10 product data corrections · D-11 swatch colours · D-12 domain · D-13 shipping values · D-14 coupon restore on cancel · D-15 operations owner · D-16 Razorpay account settings (auto-capture, KYC; and confirmation that refund idempotency keys are enabled on the account) · D-17 funding policy for payments first seen partially refunded.

## 9. Review 3 (baseline `8fe33f4`)

### 9.1 Repository state
`main` = `8fe33f4` = the reviewed baseline; clean tree; still **no application code**. The corrections are in the executable reference
SQL in `docs/database.md` (the `aq_*` functions the API is specified to call), the validator and the dependent docs. They are uncommitted
on `main`: not pushed, merged or deployed.

### 9.2 Findings: verification against the baseline
Each finding was **reproduced before fixing** with a probe against the unmodified baseline SQL (PostgreSQL 16.14):

| # | Finding | Baseline behaviour observed | Status |
|---|---------|-----------------------------|--------|
| 1 | UNLINKED payments never recovered | Capture before mapping → `UNLINKED`; after saving `provider_order_id` the next call returned `DUPLICATE`; the payment kept `order_id = NULL`, `allocation = UNLINKED`; the order stayed `PENDING_PAYMENT` | **Confirmed** |
| 2 | Payment first seen `REFUNDED` funded the order | First observation `REFUNDED` → `APPLIED`; order `PLACED` | **Confirmed** |
| 3 | Idempotency takeover not fenced | After B's takeover, stale A's `aq_idempotency_complete` succeeded and stored A's response over B's record | **Confirmed** |
| (found while testing) | `aq_raise_exception` used the dedupe key as `outbox_events.aggregate_id` (`VARCHAR(40)`) | Dedupe keys longer than 40 characters (e.g. `PAYMENT_IDENTITY_CONFLICT:<payment>:<provider order>`) failed the whole transaction | **Confirmed and fixed** (aggregate id = exception row id) |

### 9.3 Corrections

| # | Correction | Where | Type |
|---|------------|-------|------|
| 1 | Explicit recovery transition `UNLINKED → bound (order_id, attempt_id), allocation NULL`, performed under the order lock and gated by `WHERE allocation = 'UNLINKED' AND order_id IS NULL AND provider_order_id = <reported>`; then the normal allocation gate runs (so duplicates stay duplicates). Identity (provider order, amount, currency, bound order) is never overwritten; a mismatching report returns `CONFLICT` + `PAYMENT_IDENTITY_CONFLICT`. The `UNLINKED_PAYMENT` exception now carries the payment id, stays OPEN while unmatched, and is RESOLVED only after recovery. The reconciler sweeps recoverable UNLINKED payments | D §3.10, §4.6, §6b, §8.2; A §7.1, §7.3, §7.4; API §3.8 | Doc + Exec (C14) |
| 2 | Capture history is separated from funding eligibility. `aq_apply_provider_payment` takes the provider's `amount_refunded`; `payments.provider_amount_refunded` (monotonic). First observation fully refunded ⇒ new allocation `VOID` (no order, inventory, coupon, history or outbox effects); partially refunded ⇒ `HELD` + `REFUNDED_BEFORE_APPLY` (OPEN) because no funding policy exists. Money already refunded is recorded once as a `PROCESSED` `PROVIDER_INITIATED` refund, so payment capacity blocks a second refund; only the remainder of a HELD payment is refundable. Later observations on allocated payments are side-effect free; if the provider reports more refunded than the ledger counts ⇒ `RECON_MISMATCH` (order totals not auto-adjusted) | D §3.10, §4.6, §5, §6, §6b, §8.2; A §7.1, §7.3, §7.4; API §3.8 | Doc + Exec (C15) |
| 3 | `idempotency_keys.owner_token` + `generation`. `NEW`/`TAKEOVER` issue a fresh token (generation + 1). New `aq_idempotency_assert_owner` (first statement of each transaction), `aq_idempotency_attach`, `aq_idempotency_renew`; `aq_idempotency_complete` now requires the token. Stale owners are rejected inside the transaction, so their domain changes roll back; the API answers them 409 `REQUEST_SUPERSEDED`. Takeover returns the attached resource and the new owner resumes it; refund attempt keys and requests are unchanged | D §3.10, §4.1, §6b, §8.1, §8.5; A §4, §7.3; API §1.1–§1.2; T 1.10 | Doc + Exec (C10) |

Signature changes (no deployed callers exist; the validator and docs were updated):
`aq_apply_provider_payment(provider_order_id, payment_id, amount, currency, status, amount_refunded, captured_at, method, raw, actor)`;
`aq_idempotency_begin(...)` now also returns `owner_token, generation`;
`aq_idempotency_complete(scope, op, key, owner_token, code, body, resource_type, resource_id)`.
Schema: `payments.provider_amount_refunded`, `idempotency_keys.owner_token/generation`, enum values `PaymentAllocation.VOID`,
`RefundKind.PROVIDER_INITIATED`, `ExceptionType.PAYMENT_IDENTITY_CONFLICT` / `REFUNDED_BEFORE_APPLY`; checks updated.

### 9.4 Tests executed
`cd tools/doc-validation && npm run validate` (PostgreSQL 16.14) and `PG_BIN_DIR=<pg18>/bin npm run validate` (18.3): **all 16 checks PASS on both**.
New or extended checks:

| Check | Scenarios (all executed) | Result |
|-------|--------------------------|--------|
| C10 (extended) | A owns and creates the order, stalls; lease expires; B `TAKEOVER` (gen 2) receives the order and resumes without a second order; A's resource mutation + attach, assert, renew and complete are all rejected and A's insert rolls back; B completes; later requests replay B; refund takeover resumes the same refund with an unchanged provider key and request; 10 concurrent takeovers → exactly one owner; 10 concurrent NEW → one owner | PASS |
| C14 (new) | Capture before mapping → UNLINKED (exception OPEN, no order effects); conflicting order mapping and amount → CONFLICT, not attached; mapping saved; 5 concurrent webhook/verify/reconciler + 3 sequential calls → 1 APPLIED, 7 DUPLICATE; order, coupon, sold count, cart, history, `order.placed`, reservations each exactly once; exception RESOLVED; unmatched payment stays OPEN; bound payment reported under another order → CONFLICT | PASS |
| C15 (new) | First observation fully REFUNDED → VOID (order unpaid, PROVIDER_INITIATED refund, capacity exhausted, further refund rejected); older CAPTURED afterwards → DUPLICATE, status stays REFUNDED; partially refunded first → HELD (OPEN, only remainder refundable); CAPTURED → own refund → REFUNDED reconciles without exception; dashboard refund → one RECON_MISMATCH, totals untouched, no new refund; 6 concurrent fully-refunded observations → 1 VOID, 1 refund record; mixed CAPTURED/REFUNDED race → exactly one allocation, fulfilment only if funded | PASS |

Stability: C03, C10, C14 and C15 together re-run 8 times on 16.14, 0 failures. All earlier checks (C00–C13) still pass with the new signatures.

### 9.5 Remaining limitations and provider assumptions
- **No application code**: the TypeScript middleware/services that must carry the owner token, map `IDEMPOTENCY_OWNERSHIP_LOST` to 409 and call the reconciler sweep are unimplemented (tasks 1.10, 4.9; AT-20, AT-22, AT-23).
- **Not verified against a live Razorpay account:** the payment entity's `amount_refunded` and `refund_status` semantics (assumed: partial refunds keep status `captured`; `refunded` means fully refunded); whether a webhook can precede the order-create response in practice; refund listing used to explain provider refunds.
- `RECON_MISMATCH` for provider refunds on allocated payments is **surfaced, not auto-corrected**: staff record the external refund (an admin action to add) so order totals stay consistent. A partially refunded `HELD` payment has **no funding policy**; it stays HELD until a business decision (D-17 below).
- A stale owner that already created a Razorpay order before being fenced leaves a provider order with the same receipt; the resuming owner adopts it by receipt (provider behaviour unverified, task 4.0).

### 9.6 Migration / rollout
- Nothing is deployed, so these are **initial-migration** changes: regenerate `0001_init` from the updated schema and ship `0002`/`0003` as embedded; no data migration.
- If a version of `0003` had ever been applied, `aq_idempotency_begin` and `aq_apply_provider_payment` change signature/return type: `DROP FUNCTION` the old signatures first (`CREATE OR REPLACE` cannot change a return type), add the columns with defaults, and backfill `owner_token = gen_random_uuid()` for any `PROCESSING` idempotency rows before adding `idempotency_owner_ck`.
- Deploy API and worker together: callers must pass `amount_refunded` and owner tokens in the same release as the new functions.
- New business decision **D-17**: funding policy for payments first seen partially refunded (default: HELD for manual review; staff may refund the remainder).
