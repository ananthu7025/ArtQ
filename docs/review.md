# ArtQ: Architecture Review (2026-10-01)

Senior architecture/solution review of the planning documents, with the resulting changes. Use it to see **what changed, why, and where**.

## 1. Repository state at review time
- `main` at `fe85b89`: `README.md`, `docs/*.md` (7 documents), `ArtQ Site Ref.png`, `ArtQ_Product_Import_All_Items.xlsx`, `.claude/settings.json`. **No application code** exists, so every finding below is a **design/documentation fix**. No runtime bug has been "fixed", because there is no runtime yet.
- The GitHub repository is **public** and contains the client's product spreadsheet and site screenshot. Recommendation (owner decision): make the repository private or remove the client files from history.
- The admin screenshot referenced in the review brief was **not available** to the reviewer (not attached, not in the repo). Admin requirements were derived from the brief's explicit list of visible modules and Products-page features; no other modules were inferred.

## 2. Issue-to-fix matrix
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

## 3. Scope & estimates (summary)
- **MVP:** storefront, accounts (email), guest checkout, Razorpay + COD, reconciliation, refunds/returns/credit notes, inventory reservations, coupons, shipping rules, full admin incl. screenshot modules and operations views, CMS, SEO.
- **Post-launch:** SMS/WhatsApp + phone login, courier API, reviews, abandoned carts, collections, advanced reports, split shipments, bundles, loyalty, PWA.
- **Effort:** 109.5 dev-days + 16.5 contingency ≈ **126 dev-days**; **16–19 calendar weeks** for two developers at 8 dev-days/week (tasklist.md).

## 4. Validation results

### 4.1 Checks executed (documentation artifacts, not application tests)
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

### 4.2 Not executed
- **No application tests exist or were run**; there is no code. AT-01…AT-14 (tasklist.md) are specified and become CI gates during implementation.
- Razorpay API capabilities assumed in architecture.md §7 (fetch order by receipt, list payments of an order, refund receipts, event-id header, late authorization) were **not verified** against a live/test account. Task 4.0 verifies them.
- Prisma 7 compatibility, the Next.js/sharp/argon2 Node 24 build and email-provider idempotency support are verified in task 0.1.
- GST rates/HSN codes and invoice rules need accountant confirmation (D-1–D-3).

## 5. Open decisions
Business inputs only; the full list with defaults and deadlines is in [product.md §11](product.md#11-open-decisions-business-inputs-only): D-1 tax classification · D-2 invoice timing/format · D-3 tax on shipping/COD fee · D-4 COD parameters · D-5 return policy · D-6 serviceability policy · D-7 courier & resin carriage · D-8 large resin packs · D-9 prepaid RTO refund · D-10 product data corrections · D-11 swatch colours · D-12 domain · D-13 shipping values · D-14 coupon restore on cancel · D-15 operations owner · D-16 Razorpay account settings.
