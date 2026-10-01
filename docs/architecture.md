# ArtQ: Technical Architecture

> Companion docs: [database.md](database.md) (data model) · [api.md](api.md) (endpoints) · [tasklist.md](tasklist.md) (build order)

---

## 1. Architecture at a glance

```mermaid
flowchart LR
  subgraph Clients
    B[Customer browser / mobile]
    A[Admin browser]
  end
  subgraph Vercel
    W[apps/web<br/>Next.js storefront<br/>SSR + ISR]
    AD[apps/admin<br/>React + Vite SPA]
  end
  subgraph "API server (Docker on Railway / VPS)"
    API[apps/api<br/>Node 20 + Express + TS]
    WK[apps/api worker<br/>BullMQ jobs]
  end
  PG[(PostgreSQL 16)]
  RD[(Redis 7)]
  R2[(Cloudflare R2<br/>images & videos)]
  CDN[Cloudflare CDN<br/>cdn.artq.in]
  RZ[Razorpay]
  EM[Email: Resend / SES]
  SMS[SMS/WhatsApp: MSG91<br/>Phase 9]
  SR[Shiprocket<br/>Phase 9]

  B --> W
  B -- client calls --> API
  A --> AD --> API
  W -- server fetch --> API
  API --> PG
  API --> RD
  WK --> PG
  WK --> RD
  API -- presigned upload --> R2
  R2 --> CDN --> B
  API <--> RZ
  RZ -- webhooks --> API
  WK --> EM
  WK --> SMS
  API <--> SR
```

**Why this shape**
- The reference prototype is a client-only React SPA, which is weak for SEO. Product and category pages must rank on Google, so the
  storefront is **Next.js** with server rendering and incremental static regeneration (ISR).
- The **API is separate** (like the reference's `qcraft.backend…`) so storefront, admin and a future mobile app all share one backend
  and business rules live in exactly one place.
- The **admin is a separate SPA** because it needs no SEO and benefits from a rich client (tables, forms), and its deploy is isolated from the shop.
- **Jobs** (emails, stock release, abandoned carts, image processing) run in a worker process so API requests stay fast.

### 1.1 Rule: the Node.js API is the only backend
Next.js is used **only as a rendering layer** (server-side rendering for SEO + React UI). It has:
- **no** API route handlers (`app/api/*`), **no** Server Actions, **no** database access, **no** secrets except public keys;
- **no** auth/session logic: login, refresh, cart and checkout calls go from the browser **directly to the Node.js API** (`api.artq.in`), which owns the cookies;
- server components only `fetch()` **public, read-only** API endpoints (catalogue, content, settings) for SEO pages.

Consequence: the storefront could be swapped for a plain React SPA or a mobile app without touching the backend.

| Responsibility | Lives in |
|---|---|
| Auth, OTP, sessions, roles | Node.js API |
| Cart, pricing, coupons, shipping calc | Node.js API |
| Orders, Razorpay, webhooks, refunds | Node.js API |
| Emails, jobs, image processing, imports | Node.js worker (BullMQ + Redis) |
| Admin operations | Node.js API (admin SPA is a pure client) |
| SEO HTML, page rendering, UI state | Next.js (frontend only) |

### 1.2 What Redis + BullMQ are used for
| Use | Example |
|-----|---------|
| Email/SMS sending with retries | Order confirmation, OTP, shipped notice |
| Delayed jobs | "Payment failed, retry" email 15 min after an unpaid order |
| Scheduled (cron) jobs | Release stock of unpaid orders every 5 min, abandoned-cart reminders, 8 AM daily report, nightly cleanup |
| Heavy work off the request | Image resizing (sharp), Excel product import, back-in-stock emails to many subscribers |
| Rate limiting & OTP throttling | 10 login attempts/min/IP, 5 OTPs/hour/phone |
| Cache | Navigation, types/categories, settings (invalidated on admin save) |

---

## 2. Tech stack (decisions)

| Layer | Choice | Version | Reason |
|-------|--------|---------|--------|
| Language | **TypeScript** everywhere | 5.x | One language, shared types |
| Monorepo | **pnpm workspaces + Turborepo** | pnpm 9, turbo 2 | Shared packages, cached builds |
| Storefront | **Next.js (App Router)** + React | 15 / 19 | SSR/ISR for SEO, image optimisation. **Frontend only**: no route handlers/Server Actions |
| Styling | **Tailwind CSS** + CSS variables | 4 | Matches token-based design system, fast |
| Client state | **Zustand** (cart drawer, UI) + **TanStack Query** (server state) | 5 / 5 | Simple; reference used Redux, which is unnecessary here |
| Forms & validation | **React Hook Form** + **Zod** | 7 / 3 | Zod schemas shared with API |
| Admin | **React + Vite + React Router + TanStack Query + TanStack Table + shadcn/ui** | 19 / 6 / 7 | Productive CRUD UI |
| Rich text | **Tiptap** (admin editor) → sanitized HTML | 2 | Descriptions, CMS pages |
| Charts (admin) | **Recharts** | 2 | Dashboard |
| API | **Node.js + Express** | 20 LTS / 5 | Simple, well known; reference backend is Express-like |
| ORM | **Prisma** | 6 | Type-safe queries, migrations |
| Database | **PostgreSQL** | 16 | Relational data, transactions for stock/orders, full-text search, `pg_trgm` |
| Cache / queue | **Redis** + **BullMQ** | 7 / 5 | Jobs, rate limits, OTP throttling, cache |
| Object storage | **Cloudflare R2** (S3 API) + CDN | n/a | Cheap, no egress fees |
| Image processing | **sharp** (in worker) | 0.33 | Resize to WebP/AVIF variants |
| Payments | **Razorpay** Orders API + Checkout.js + Webhooks | n/a | UPI/cards/netbanking in India; reference uses it |
| Email | **Resend** (or Amazon SES) + **React Email** templates | n/a | Transactional email |
| SMS / WhatsApp OTP | **MSG91** (needs DLT registration) | Phase 9 | Indian SMS compliance |
| Shipping | Manual AWB entry at launch → **Shiprocket API** | Phase 9 | Rates, labels, tracking webhooks |
| PDF | **@react-pdf/renderer** (server) | n/a | GST invoices & packing slips |
| Excel import/export | **exceljs** | 4 | Read the client's `.xlsx` template |
| Auth | Own implementation: **argon2id** + **JWT access (15 min)** + **httpOnly refresh cookie (30 d, rotated)** | n/a | Full control; supports OTP & guest |
| Testing | **Vitest** (unit), **Supertest** (API), **Playwright** (E2E) | n/a | n/a |
| Lint/format | ESLint, Prettier, `tsc --noEmit` | n/a | n/a |
| Monitoring | **Sentry** (web, admin, api), **Better Stack / UptimeRobot**, pino logs | n/a | n/a |
| Analytics | GA4, Meta Pixel + CAPI, Google Search Console, Microsoft Clarity | n/a | n/a |
| Hosting | Vercel (web + admin), **Railway/Render** or a **Hetzner/DigitalOcean VPS with Docker** (api + worker), Neon/Railway Postgres, Upstash/Railway Redis | n/a | Low ops, scales later |

> **Alternative if the client prefers lower build cost:** use Shopify with a custom theme (the Saawariya theme in the workspace).
> That removes the API, DB, admin, payments and shipping work (~60 % of tasks) but limits custom logic. This document assumes the **custom build**.

---

## 3. Repository structure

```
artq/
├── apps/
│   ├── web/                         # Next.js storefront  → artq.in
│   │   ├── app/
│   │   │   ├── (shop)/
│   │   │   │   ├── page.tsx                         # Home
│   │   │   │   ├── shop/page.tsx
│   │   │   │   ├── type/[slug]/page.tsx
│   │   │   │   ├── category/[slug]/page.tsx
│   │   │   │   ├── technique/[slug]/page.tsx
│   │   │   │   ├── collection/[slug]/page.tsx
│   │   │   │   ├── new-arrivals/page.tsx
│   │   │   │   ├── trending/page.tsx
│   │   │   │   ├── search/page.tsx
│   │   │   │   ├── product/[slug]/page.tsx
│   │   │   │   ├── cart/page.tsx
│   │   │   │   ├── checkout/page.tsx
│   │   │   │   ├── checkout/success/[orderNumber]/page.tsx
│   │   │   │   ├── wishlist/page.tsx
│   │   │   │   └── (content)/about|contact|faqs|custom-work|[policy]/page.tsx
│   │   │   ├── (auth)/login|signup|guest-login|forgot-password|reset-password/page.tsx
│   │   │   ├── (account)/account/page.tsx, account/addresses/page.tsx, orders/..., layout.tsx (auth guard)
│   │   │   └── sitemap.ts  robots.ts  not-found.tsx  error.tsx  layout.tsx
│   │   │       # NOTE: no app/api/* route handlers and no Server Actions (see §1.1)
│   │   ├── components/   (layout/, home/, product/, listing/, cart/, checkout/, account/, common/)
│   │   ├── lib/          (api-client.ts → calls Node API, auth-client.ts, analytics.ts, format.ts, seo.ts)
│   │   ├── stores/       (cart-ui.ts, wishlist-guest.ts, recently-viewed.ts)
│   │   └── public/       (favicon, logo.svg, og-default.jpg)
│   │
│   ├── admin/                       # React + Vite admin  → admin.artq.in
│   │   └── src/
│   │       ├── routes/  (dashboard, products, products/$id, import, inventory, types, categories,
│   │       │             techniques, collections, orders, orders/$number, returns, customers, coupons,
│   │       │             shipping, content/*, marketing/*, seo, messages, settings/*, login)
│   │       ├── components/ (DataTable, ImageUploader, VariantGrid, RichText, StatusPill, ...)
│   │       └── lib/ (api.ts, auth.ts, permissions.ts)
│   │
│   └── api/                         # Express API + worker  → api.artq.in
│       ├── prisma/
│       │   ├── schema.prisma
│       │   ├── migrations/
│       │   └── seed/ (index.ts, states.ts, shipping.ts, settings.ts, catalog-from-xlsx.ts)
│       ├── src/
│       │   ├── server.ts                 # HTTP entry
│       │   ├── worker.ts                 # BullMQ worker entry
│       │   ├── app.ts                    # express app, middleware chain
│       │   ├── config/env.ts             # zod-validated env
│       │   ├── lib/ (prisma.ts, redis.ts, logger.ts, errors.ts, money.ts, slug.ts, storage.ts, razorpay.ts, mailer.ts)
│       │   ├── middleware/ (auth.ts, requireRole.ts, validate.ts, rateLimit.ts, cartToken.ts, errorHandler.ts, requestId.ts)
│       │   ├── modules/
│       │   │   ├── auth/        (routes, controller, service, schemas)
│       │   │   ├── catalog/     (types, categories, techniques, collections, products, search)
│       │   │   ├── cart/
│       │   │   ├── wishlist/
│       │   │   ├── checkout/    (pricing.service.ts, shipping.service.ts, coupon.service.ts)
│       │   │   ├── orders/
│       │   │   ├── payments/    (razorpay webhook)
│       │   │   ├── users/       (profile, addresses)
│       │   │   ├── content/     (reels, testimonials, faqs, pages, settings, newsletter, contact)
│       │   │   ├── inventory/
│       │   │   ├── notifications/
│       │   │   ├── media/       (presigned uploads)
│       │   │   ├── imports/     (xlsx parser, validator, importer)
│       │   │   └── admin/       (dashboard, customers, reports, audit)
│       │   ├── jobs/ (queues.ts, email.job.ts, release-stock.job.ts, abandoned-cart.job.ts,
│       │   │          restock-notify.job.ts, image-process.job.ts, daily-reports.job.ts, sitemap.job.ts)
│       │   └── emails/ (React Email templates)
│       ├── test/
│       └── Dockerfile
│
├── packages/
│   ├── shared/        # zod schemas, enums (OrderStatus…), DTO types, money & slug helpers, constants
│   ├── ui/            # Tailwind preset (tokens), shared React primitives (Button, Price, Badge)
│   ├── config/        # eslint, tsconfig, prettier presets
│   └── emails/        # (optional) shared React Email components
│
├── docs/              # ← these documents
├── docker-compose.yml # postgres, redis, mailpit, minio (local R2) for development
├── turbo.json  pnpm-workspace.yaml  package.json  .env.example
└── .github/workflows/ (ci.yml, deploy-api.yml)
```

### Module pattern inside the API
```
modules/orders/
  orders.routes.ts      # express Router; path + middleware (auth, validate(zodSchema)) → controller
  orders.controller.ts  # parse req → call service → shape response (no business logic)
  orders.service.ts     # business logic, transactions, emits jobs
  orders.repo.ts        # (optional) complex Prisma queries
  orders.schemas.ts     # zod request/response schemas (re-exported from packages/shared where shared)
  orders.test.ts
```

---

## 4. Request lifecycle & middleware

```
request → requestId → pino-http logger → helmet → cors(allowlist) → compression
        → express.json(1mb) / raw body for /webhooks/razorpay
        → cookieParser → rateLimit (Redis) → cartToken (reads/issues `aq_cart` cookie)
        → authOptional | authRequired | requireRole('ADMIN')
        → validate({body, query, params}) with zod
        → controller → service → prisma
        → errorHandler (maps AppError → {error:{code,message,details}}, Sentry for 5xx)
```

**Error format** (all endpoints):
```json
{ "error": { "code": "OUT_OF_STOCK", "message": "Only 2 left for 2:1 Epoxy Resin – 750 gm", "details": { "variantId": 12, "available": 2 } } }
```
HTTP codes: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict (stock, duplicate), 422 business rule, 429 rate limited, 500.

---

## 5. Authentication & authorisation

### 5.1 Tokens
| Token | Where | Lifetime | Content |
|-------|-------|----------|---------|
| Access JWT (HS256 / EdDSA) | Memory (web), `Authorization: Bearer` | 15 min | `sub` (user id), `role`, `sid` (session id) |
| Refresh token | `httpOnly; Secure; SameSite=Lax; Path=/auth` cookie `aq_rt` on `.artq.in` | 30 days (sliding), **rotated on every use** | Random 256-bit; only SHA-256 hash stored in `sessions` |
| Cart token | `aq_cart` cookie, httpOnly | 30 days | Random id → `carts.token` |

- **Refresh reuse detection:** if a rotated (old) refresh token is presented again, revoke the whole session family (token theft).
- The browser talks to `api.artq.in` directly with `credentials: 'include'`. On page load the web app calls `POST /v1/auth/refresh` (cookie) to obtain an access token held in memory; a 401 triggers one silent refresh + retry.
- Next.js never sees or forwards user tokens: personalised pages (account, orders, cart, checkout, wishlist) are **client-rendered**, and SEO pages are public and identical for everyone.
- Because web (`artq.in`) and API (`api.artq.in`) share the registrable domain, cookies are first-party (`SameSite=Lax`, `Domain=.artq.in`). For local dev both run on `localhost`.
- Admin uses the same auth with role check, plus **TOTP 2FA** for SUPER_ADMIN/ADMIN (setting).

### 5.2 OTP
- 6 digits, stored as `sha256(code + pepper)` in `otp_codes`, 10-min expiry, max 5 attempts, resend cooldown 30 s, max 5 sends/hour per target (Redis counters).
- Purposes: `SIGNUP_VERIFY`, `LOGIN`, `GUEST_ORDER_ACCESS`, `EMAIL_CHANGE`, `CHECKOUT_VERIFY`.

### 5.3 Roles & permissions
| Permission | CUSTOMER | STAFF | ADMIN | SUPER_ADMIN |
|------------|:-------:|:-----:|:-----:|:-----------:|
| Shop, own orders, own profile | ✓ | ✓ | ✓ | ✓ |
| View/update orders, print invoices | | ✓ | ✓ | ✓ |
| Edit stock | | ✓ | ✓ | ✓ |
| Products, categories, content, coupons, customers | | | ✓ | ✓ |
| Refunds | | | ✓ | ✓ |
| Settings, payment keys, staff users, audit log | | | | ✓ |

Implemented as `requirePermission('orders:write')` with a static role→permission map in `packages/shared`.

---

## 6. Catalogue, pricing & search

### 6.1 Read path (storefront)
- Next.js pages fetch **public** endpoints from the Node API at render time with `fetch(url, { next: { revalidate: 60 } })` (time-based ISR). Admin changes appear on the site within ~60 s. No webhook from API to Next.js is needed, which keeps Next.js free of backend code.
- **Stock & price on PDP** are re-fetched client-side (no cache) on mount so cached HTML never sells out-of-stock items; the cart/checkout always uses live server data.

### 6.2 Listing query
`GET /products?type=pigments&category=gel-pigments&technique=&minPrice=&maxPrice=&size=20gm&color=&inStock=1&sale=1&sort=price_asc&page=1&limit=24`
- Implemented with Prisma + a raw SQL fragment for price sort (uses denormalised `products.min_price`, `max_price`, `total_stock`, refreshed by service on every variant change).
- Facets (sizes, colours, price bounds, counts) returned in the same response under `facets`.

### 6.3 Search
- Postgres `tsvector` column `products.search_vector` (generated from name A-weight, category/type B, tags/SKU C, description D) with GIN index.
- `pg_trgm` similarity on name for typo tolerance and the autocomplete endpoint (`/search/suggest?q=`), limit 8.
- Upgrade path: Meilisearch if catalogue grows past ~5k products.

### 6.4 Pricing engine (`checkout/pricing.service.ts`)
Single pure function used by cart, checkout and order creation so numbers always match:
```
priceCart(items, {couponCode, shippingAddress, paymentMethod, user}) →
  1. load variants (price, mrp, stock, weight, active) — reject inactive/deleted
  2. lineTotal = price × qty ; mrpTotal = (mrp ?? price) × qty
  3. subtotal = Σ lineTotal ; mrpDiscount = Σ(mrpTotal − lineTotal)
  4. coupon = validateCoupon(...) → couponDiscount (capped), allocate per line
  5. weight = Σ weight_g × qty + PACKAGING_WEIGHT_G
  6. shipping = free if (subtotal − couponDiscount) ≥ FREE_THRESHOLD or coupon FREE_SHIPPING
              else rateFor(zone(state), weight)   (no address ⇒ estimate with default zone, flagged estimated)
  7. codFee = method === COD ? COD_FEE : 0
  8. total = subtotal − couponDiscount + shipping + codFee
  9. tax breakup per line for invoice (inclusive GST)
  returns { lines[], subtotal, mrpTotal, mrpDiscount, couponDiscount, shipping, shippingEstimated, codFee, total, weightG, freeShippingRemaining, warnings[] }
```
All amounts are **integers in paise**; rounding happens once per line using banker's rounding helper in `packages/shared/money.ts`.

---

## 7. Checkout, payment & stock: sequence

```mermaid
sequenceDiagram
  participant C as Customer (web)
  participant API
  participant DB as Postgres
  participant RZ as Razorpay
  participant Q as Worker

  C->>API: POST /checkout/initiate {address, method:RAZORPAY, coupon}
  API->>DB: BEGIN; re-price cart; for each line UPDATE variants SET stock=stock-qty WHERE id=? AND stock>=qty
  alt any update affects 0 rows
    API-->>C: 409 OUT_OF_STOCK (ROLLBACK)
  end
  API->>DB: INSERT order(PENDING_PAYMENT, expires_at=now+30m), items, inventory_movements; COMMIT
  API->>RZ: orders.create({amount, currency:INR, receipt: AQ10234, notes})
  API->>DB: INSERT payments(CREATED, rz_order_id)
  API-->>C: {orderNumber, razorpayOrderId, amount, key}
  C->>RZ: Checkout.js modal (UPI/card)
  RZ-->>C: payment_id, signature
  C->>API: POST /checkout/verify {rz_order_id, rz_payment_id, signature}
  API->>API: HMAC_SHA256(order_id|payment_id, key_secret) == signature ?
  API->>DB: payment CAPTURED, order PLACED/PAID, coupon redemption, cart CONVERTED (idempotent)
  API->>Q: enqueue email.order_placed, admin.notify
  API-->>C: {orderNumber} → /checkout/success
  RZ-->>API: webhook payment.captured (signature X-Razorpay-Signature) → same idempotent "markPaid"
  Q->>DB: every 5 min: orders PENDING_PAYMENT & expires_at<now → EXPIRED, restore stock
```

Key guarantees:
- **Idempotency:** `markOrderPaid(orderId, paymentId)` runs inside a transaction with `SELECT … FOR UPDATE` on the order; if already PAID it returns success. Webhook events are stored in `webhook_events` (unique `event_id`) to skip duplicates.
- **Late payment after expiry:** if a capture arrives for an EXPIRED order, try to re-reserve stock; if impossible, auto-refund and email the customer.
- **Amount check:** captured amount must equal `order.total`; otherwise flag for review.
- **COD:** `POST /checkout/initiate {method: COD}` reserves stock and creates order `PLACED` directly (optionally after OTP verification of phone).
- **Retry payment:** `POST /orders/:number/retry-payment` creates a new Razorpay order for the same PENDING order (if not expired).

---

## 8. Shipping & fulfilment

**Phase 1 (launch):** rates from `shipping_zones` + `shipping_rate_slabs`; admin enters courier + AWB + tracking URL when marking SHIPPED; tracking page shows status history.

**Phase 9 (Shiprocket):**
- On CONFIRMED → create Shiprocket order (adhoc) with dimensions/weight → assign AWB → generate label PDF + pickup.
- Webhook `shiprocket/tracking` updates status (SHIPPED → OUT_FOR_DELIVERY → DELIVERED / RTO).
- PDP pincode check uses Shiprocket serviceability API (cached 24 h per pincode in Redis).

Pincode → city/state: seed a `pincodes` table from the India Post open dataset (~19k rows), so there is no runtime dependency.

---

## 9. Media pipeline

1. Admin requests `POST /admin/media/presign {filename, contentType, size}` → API validates type (jpg/png/webp/avif/mp4/webm) and size (images ≤ 15 MB, video ≤ 50 MB) → returns presigned PUT URL to R2 `originals/{uuid}.{ext}`.
2. Browser uploads directly to R2 (no load on API).
3. Admin calls `POST /admin/media/complete {key}` → creates `media` row (status PROCESSING) → enqueues `image-process` job.
4. Worker (sharp) generates WebP + AVIF at widths **160, 320, 640, 960, 1280, 1600** → `media/{uuid}/{w}.webp|avif`; stores width/height, blurhash/LQIP base64; status READY.
5. Frontends render `<picture>` / `next/image` with a custom loader `https://cdn.artq.in/media/{uuid}/{w}.webp`.
6. Videos: stored as-is (admin uploads web-optimised MP4); poster frame uploaded as image. (Upgrade: Cloudflare Stream / Mux.)
7. Import from spreadsheet: image URLs (Drive/Dropbox links) are **downloaded by the worker** and re-hosted to R2 (Google Drive share links converted to direct-download form).

---

## 10. Background jobs (BullMQ queues)

| Queue / job | Trigger | Schedule | Action |
|-------------|---------|----------|--------|
| `email.send` | services | on demand | Render React Email → send via Resend; retry 5× exp backoff; log in `email_logs` |
| `orders.expire-pending` | repeatable | every 5 min | PENDING_PAYMENT past `expires_at` → EXPIRED + restore stock |
| `orders.payment-failed-nudge` | on order create (delay 15 min) | n/a | If still unpaid, email retry link |
| `cart.abandoned` | repeatable | every 30 min | Carts with contact + items, inactive 1 h / 24 h, not converted → reminder email (max 2) |
| `stock.restock-notify` | variant stock 0→>0 | on demand | Email all PENDING notifications (batch 100) → mark NOTIFIED |
| `media.process` | upload complete | on demand | sharp variants |
| `import.products` | admin confirms import | on demand | Apply rows in batches of 50, progress in `product_imports` |
| `reports.daily` | repeatable | 08:00 IST | Admin daily summary + low-stock email |
| `cleanup` | repeatable | 03:00 IST | Delete expired OTPs, sessions, old carts (90 d), webhook events (90 d) |

---

## 11. Security checklist

- HTTPS everywhere (HSTS), `helmet` headers, strict CSP on web (allow Razorpay `checkout.razorpay.com`, GA, Meta, CDN).
- CORS allowlist: `https://artq.in`, `https://www.artq.in`, `https://admin.artq.in`, localhost in dev.
- **Never trust client prices/totals**: everything recomputed server-side.
- Zod validation on every input; Prisma parameterised queries (no raw string SQL concatenation).
- Rich text sanitised server-side with `sanitize-html` allowlist.
- Rate limits (Redis sliding window): auth 10/min/IP, OTP send 5/h/target, checkout 20/min/user, contact/newsletter 5/min/IP, general 300/min/IP.
- Passwords argon2id (m=19456, t=2, p=1). Lockout after 5 failures for 15 min.
- Razorpay: verify checkout signature + webhook signature (raw body), store keys only in env/secret manager; admin settings show masked key.
- Uploads: presigned with content-type + size conditions; images re-encoded by sharp (strips EXIF/malicious payloads).
- Admin: 2FA, role-based permissions, audit log for every mutating admin action (`audit_logs`), IP + user agent stored.
- Secrets in Railway/Vercel env; `.env` never committed; `env.ts` crashes on missing vars at boot.
- Dependency scanning (GitHub Dependabot), `pnpm audit` in CI.
- PII: phone/email only visible to staff with permission; data export/delete on request (DPDP Act).
- Backups: daily automated + weekly restore test.

---

## 12. Environments & deployment

| Env | Web | Admin | API | DB | Notes |
|-----|-----|-------|-----|----|-------|
| local | `localhost:3000` | `localhost:5173` | `localhost:4000` | docker postgres | Mailpit catches email (`localhost:8025`), MinIO as R2 |
| staging | `staging.artq.in` | `admin-staging.artq.in` | `api-staging.artq.in` | separate DB | Razorpay **test keys**, robots `noindex`, basic-auth |
| production | `artq.in` (+ `www` → 301) | `admin.artq.in` | `api.artq.in` | managed PG with PITR | Razorpay live keys |

**CI (GitHub Actions)** on every PR: install (pnpm cache) → lint → typecheck → unit tests → API integration tests (service containers: postgres, redis) → build all apps → Playwright smoke against preview.
**CD:** merge to `main` → Vercel deploys web/admin automatically; API Docker image built and deployed to Railway/VPS; `prisma migrate deploy` runs as a release step **before** the new API starts.

### Environment variables (`.env.example`)
```
# api
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://artq:artq@localhost:5432/artq
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=
REFRESH_TOKEN_PEPPER=
OTP_PEPPER=
COOKIE_DOMAIN=.artq.in
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
WEB_URL=http://localhost:3000
ADMIN_URL=http://localhost:5173
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=artq-media
CDN_URL=https://cdn.artq.in
RESEND_API_KEY=
MAIL_FROM="ArtQ <orders@artq.in>"
ADMIN_NOTIFY_EMAILS=owner@artq.in
SENTRY_DSN=
# web
NEXT_PUBLIC_API_URL=http://localhost:4000/v1
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_CDN_URL=
NEXT_PUBLIC_RAZORPAY_KEY_ID=
NEXT_PUBLIC_GA_ID=
NEXT_PUBLIC_META_PIXEL_ID=
NEXT_PUBLIC_WHATSAPP_NUMBER=91XXXXXXXXXX
# (web has only NEXT_PUBLIC_* values: no secrets, because it is frontend-only)
# admin
VITE_API_URL=http://localhost:4000/v1
```

---

## 13. Performance plan
- ISR for home/listing/PDP (time-based, revalidate 60 s); static content pages. Sitemap (`sitemap.ts`) is built from the public API `GET /v1/seo/sitemap-entries`, revalidated hourly.
- `next/image` with CDN loader, `priority` on hero poster & first product image, `sizes` attributes set per grid.
- Fonts via `next/font` (no layout shift), subset Latin.
- Hero video `preload="none"` with poster; load after LCP; skip on `saveData`.
- Reels lazy-load (`IntersectionObserver`), only visible ones play.
- Code splitting: Razorpay script loaded only on checkout; lightbox/zoom dynamic import.
- API: Prisma `select` only needed fields; indexes per database.md; Redis cache for settings, navigation, types/categories (invalidated on admin save); HTTP `Cache-Control` for public GETs (`s-maxage=60, stale-while-revalidate=300`).
- DB connection pooling (PgBouncer / Prisma Accelerate if serverless).

## 14. Observability
- Structured JSON logs (pino) with `requestId`, `userId`, `orderNumber`.
- Sentry with release tags and source maps for all three apps.
- Uptime checks: `/health` (process), `/health/ready` (DB + Redis).
- Business alerts (email/Slack): payment webhook failures, orders stuck in PENDING with captured payments, job failures > 5 in 10 min.

## 15. Scaling path
| When | Do |
|------|----|
| > 50k visits/day | Add API replicas behind load balancer; Redis cache for listing queries |
| > 5k products / complex search | Meilisearch/Typesense |
| Heavy video | Cloudflare Stream / Mux |
| Mobile app | Reuse `/v1` API; add push notifications |
| Multiple warehouses | Add `warehouses` + `stock_levels` tables (variant × warehouse) |
