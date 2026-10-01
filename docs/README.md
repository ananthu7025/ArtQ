# ArtQ: Project Documentation

ArtQ is a single-vendor Indian D2C store selling **wood frames/moulds, epoxy & UV resins, pigments, glitters, silica gel and resin-art essentials**.
These documents are the single source of truth for building it. Reference prototype: https://qcraft-nine.vercel.app/ (mobile homepage: `ArtQ Site Ref.png`).

> **Status (2026-10-01):** planning only. The repository contains documentation, the client's source files and `tools/doc-validation` (executable checks of the database layer embedded in database.md). Phase 0 has started: the monorepo scaffold (`apps/api`, `apps/web`, `apps/admin`, `packages/*`) builds and passes its smoke tests; no product features exist yet.

## Read in this order
| # | File | What it answers |
|---|------|-----------------|
| 1 | [product.md](product.md) | **What** we build: pages, admin modules (incl. the Products page), business rules, publication gate, open decisions |
| 2 | [design-system.md](design-system.md) | **How it looks**: accessible tokens (measured contrast), components, storefront and admin layouts |
| 3 | [architecture.md](architecture.md) | **How it works**: stack (Node 24 LTS), auth/sessions/MFA/CSRF, caching, pricing & shipping algorithm, payments & recovery, webhook inbox, outbox, media, operations, environments, backups |
| 4 | [database.md](database.md) | **What we store**: semantics, state machines, lock order, validated Prisma schema, integrity SQL, reference transactions, imports |
| 5 | [api.md](api.md) | **Contracts**: cookies, idempotency, storefront/guest/admin endpoints, errors, rate limits |
| 6 | [catalog.md](catalog.md) | **The products**: cleaned catalogue from the client sheet, flags, readiness |
| 7 | [tasklist.md](tasklist.md) | **Delivery**: phases, estimates, milestones, acceptance tests |
| 8 | [review.md](review.md) | **Change log** of both architecture reviews: issue-to-fix matrices, validation results, limitations |
| 9 | [compatibility.md](compatibility.md) | **Toolchain**: pinned versions and the Node 24 compatibility results (task 0.1) |
| 10 | [../tools/doc-validation](../tools/doc-validation/README.md) | **Executable checks** of the schema, integrity SQL and money/stock functions (PostgreSQL 16 + Redis/BullMQ) |

## One-paragraph summary
A **modular monolith**. The **Next.js storefront** (rendering and customer UI only, no backend code) and a **React/Vite admin** are clients of a **Node.js 24 + Express/TypeScript API**, the only backend. **PostgreSQL 16 (Prisma)** is the source of truth, including the durable webhook inbox, the transactional outbox with per-consumer deliveries, idempotency keys and payment attempts; the money/stock transactions are database functions called by the API. **Redis + BullMQ** deliver and schedule background work (emails, reconciliation, expiry, imports, image processing) but hold no state that correctness depends on. **Cloudflare R2** stores public catalogue media (CDN) and private customer files. **Razorpay** handles online payments; COD is supported. Prices are server-calculated in integer paise; orders and invoices are immutable snapshots.

## Glossary
| Term | Meaning |
|------|---------|
| **Type** | Top-level group (homepage tile, admin "Product Types"), e.g. *Resins*, *Pigments* |
| **Category** | Sub-group inside one type, e.g. *Gel Pigments* |
| **Technique** | Cross-cutting tag (reference "occasion"), e.g. *Flower Preservation* |
| **Product / Variant** | Product = page with content; Variant = buyable option with SKU, price, stock, weight |
| **Draft / Active / Archived** | Product status; only **Active** (published, gate passed) is visible |
| **On hand / Reserved / Available** | Physical stock / held by unshipped orders / on hand − reserved |
| **Reservation** | Stock held for one order item: active → consumed (shipped) or released |
| **Payment attempt** | One Razorpay order created for an ArtQ order (receipt `AQA_…`) |
| **Payment** | One Razorpay payment id; applied, excess or unlinked |
| **Payment exception** | A money/stock situation needing human attention (admin queue) |
| **Inbox / Outbox** | Durable Postgres tables for incoming webhooks / outgoing side effects |
| **Restock request** | Customer waiting for a variant to come back in stock |
| **MRP** | Maximum retail price (struck-through); selling price ≤ MRP |
| **Paise** | ₹1 = 100 paise; all money is stored as integer paise |
