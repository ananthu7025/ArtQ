# ArtQ: REST API Specification

> Base URL `https://api.artq.in/v1` (staging `https://api-staging.artq.in/v1`, local `http://localhost:4000/v1`). JSON only.
> Implemented in `apps/api` (Express). Next.js and the admin SPA are **clients only**.
> Request/response schemas are Zod schemas in `packages/shared` (strict: unknown keys → 400).
> Companion docs: architecture.md §5 (auth/cookies) and architecture.md §7 (payments), [database.md](database.md).

---

## 1. Conventions

| Topic | Rule |
|-------|------|
| Auth | Storefront: `Authorization: Bearer <access>` (10 min) + refresh cookie `__Secure-aq_rt` (`Path=/v1/auth`). Admin: Bearer (5 min) + `__Secure-aq_admin_rt` (`Path=/v1/admin/auth`), issued only after MFA. Cookie attributes: architecture.md §5.1 |
| Cart | `__Secure-aq_cart` cookie (`Path=/v1`), set by the API on the first cart call |
| Cookie-authenticated mutations | Require an allow-listed `Origin` (and `Sec-Fetch-Site` same-site/same-origin when sent) and `Content-Type: application/json`, else 403 `ORIGIN_REJECTED` / 415 |
| Money | Integer **paise** in every request and response |
| Dates | ISO-8601 UTC |
| Identifiers | Storefront: slugs, order numbers. Admin: numeric ids |
| Pagination | `?page=1&limit=24` → `{data, meta:{page, limit, total, totalPages}}` (max 100) |
| Optimistic concurrency | Admin updates send `version`; mismatch → 409 `VERSION_CONFLICT` with current data |
| Caching | Only the allow-list in architecture.md §6.1 is publicly cacheable; everything else returns `Cache-Control: private, no-store` |
| Errors | `{ "error": { "code", "message", "details" } }` |

### 1.1 Error codes
`VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `SESSION_INVALID` 401 · `STEP_UP_REQUIRED` 401 · `FORBIDDEN` 403 · `ORIGIN_REJECTED` 403 · `NOT_FOUND` 404 · `VERSION_CONFLICT` 409 · `OUT_OF_STOCK` 409 · `PRICE_CHANGED` 409 · `REQUEST_IN_PROGRESS` 409 · `REQUEST_SUPERSEDED` 409 · `REFUND_EXCEEDS_CAPACITY` 409 (`details.scope` = `item` (+ `orderItemId`) / `order` / `payment`) · `REFUND_NOT_RETRYABLE` 409 · `REFUND_NOT_CANCELLABLE` 409 · `IDEMPOTENCY_KEY_REUSED` 422 · `COUPON_INVALID` / `COUPON_EXPIRED` / `COUPON_MIN_ORDER` / `COUPON_USAGE_EXCEEDED` / `COUPON_NOT_ELIGIBLE` 422 · `COD_NOT_AVAILABLE` 422 · `PINCODE_NOT_SERVICEABLE` 422 · `SHIPPING_RESTRICTED` 422 · `NOT_PUBLISHABLE` 422 · `INVALID_TRANSITION` 422 · `RETURN_NOT_ALLOWED` 422 · `OTP_INVALID` / `OTP_EXPIRED` / `MFA_INVALID` 422 · `PAYMENT_VERIFICATION_FAILED` 422 · `ACCOUNT_LOCKED` 423 · `RATE_LIMITED` 429 · `PAYMENT_PROVIDER_UNAVAILABLE` 503 · `INTERNAL` 500.

### 1.2 Idempotency (required header `Idempotency-Key: <uuid>` on these operations)

| Operation (`operation`) | Endpoint | Scope (who) | Target resource (what) |
|-------------------------|----------|-------------|------------------------|
| `checkout.initiate` | `POST /checkout/initiate` | `user:<id>` if authenticated, else `cart:<cartId>` | `cart:<cartId>` |
| `payment.retry` | `POST /orders/:orderNumber/payment/retry` | `user:<id>` / `order:<number>` (guest order cookie) / `cart:<id>` | `order:<orderNumber>` |
| `order.cancel` | `POST /me/orders/:n/cancel`, `POST /orders/:n/cancel` (guest), `POST /admin/orders/:id/cancel` | `user:<id>` / `order:<number>` / `staff:<id>` | `order:<orderNumber>` |
| `refund.create` | `POST /admin/orders/:id/refunds` | `staff:<id>` | `order:<orderNumber>` |
| `return.create` | `POST /me/orders/:n/returns`, `POST /orders/:n/returns` | `user:<id>` / `order:<number>` | `order:<orderNumber>` |

**Fingerprint.** `request_hash = SHA-256(canonical JSON {operation, target, scope, body})` (keys sorted, no insignificant whitespace; the body after zod parsing, so defaults are explicit). The target is also stored separately (`target_resource`). Reusing a key with the same body against a **different** order is therefore a conflict, never a replay of the first order's response (verified by C10).

Behaviour (`aq_idempotency_begin`, unique `(scope, operation, key)`):

| Existing record | Target + hash | Outcome | Response |
|-----------------|---------------|---------|----------|
| none | n/a | `NEW` | Insert `PROCESSING` (lock 60 s) with a fresh **owner token** (generation 1) and execute |
| `COMPLETED` | same | `REPLAY` | Stored status code + body (header `Idempotent-Replayed: true`) |
| any | different target **or** different hash | `CONFLICT` | 422 `IDEMPOTENCY_KEY_REUSED` |
| `PROCESSING`, lock live | same | `IN_PROGRESS` | 409 `REQUEST_IN_PROGRESS`, `Retry-After: 2` |
| `PROCESSING`, lock expired (crash or stall) | same | `TAKEOVER` | Fresh owner token, generation + 1; **resume** from the attached resource (existing order/attempt/refund) instead of re-executing |

**Ownership fencing.** Only the current owner can act for a key: every transaction the request runs starts with
`aq_idempotency_assert_owner(scope, operation, key, token)`, and attaching the resource, renewing the lease (during slow provider
calls) and completing all require the token. When an earlier request resumes after a takeover, its database work rolls back
(`IDEMPOTENCY_OWNERSHIP_LOST`, internal) and the API answers that request with **409 `REQUEST_SUPERSEDED`**. The client simply
retries with the same key and receives the new owner's response (`REPLAY`) or `REQUEST_IN_PROGRESS`. Provider idempotency (refund
attempt keys, order receipts) is stored with the resource, so resuming never changes it.

Records expire after 24 h. Business-level dedupe also applies: at most one `PENDING_PAYMENT` order per cart, one open payment attempt per order, refund `idempotency_key` unique per order. Provider-facing idempotency is separate: refund attempts carry their own `X-Refund-Idempotency` key (architecture.md §10.2).

---

## 2. Shared shapes

```ts
type Money = number; // paise
type MediaRef = { id: number; url: string; width: number; height: number; alt?: string; placeholder?: string;
                  srcset: { webp: string; avif?: string } };          // only READY public media is ever returned

type ProductCard = {
  id: number; slug: string; name: string;
  image: MediaRef | null; hoverImage: MediaRef | null;                 // null ⇒ UI placeholder
  fromPrice: Money; maxPrice: Money; mrp: Money | null; discountPercent: number | null;   // over matching variants
  inStock: boolean; isNew: boolean; isTrending: boolean;
  variantCount: number; defaultVariantId: number | null;               // set when exactly one active variant
  type: { slug: string; name: string };                                // always present for ACTIVE products
};

type Variant = {
  id: number; sku: string; label: string;
  size: string | null; color: string | null; colorHex: string | null; thickness: string | null;
  price: Money; mrp: Money | null; discountPercent: number | null;
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';             // exact counts are not public
  maxQuantity: number;                                                 // min(available, 50); live endpoint only
  image: MediaRef | null;
};

type CartView = {
  items: { id: number; variantId: number; productSlug: string; productName: string; variantLabel: string;
           image: MediaRef | null; unitPrice: Money; unitMrp: Money | null; quantity: number; lineTotal: Money;
           maxQuantity: number; available: boolean; priceChanged: boolean; warning?: string }[];
  coupon: { code: string; title: string; discount: Money } | null;
  totals: { itemCount: number; subtotal: Money; mrpTotal: Money; mrpDiscount: Money; couponDiscount: Money;
            shipping: { amount: Money | null; estimated: boolean; freeApplied: boolean; heavySurcharge: Money;
                        actualWeightG: number; chargeableWeightG: number };
            codFee: Money; total: Money; savings: Money;
            freeShippingThreshold: Money; freeShippingRemaining: Money };
  warnings: string[];
};

type OrderView = {
  orderNumber: string; createdAt: string;
  status: OrderStatus; paymentStatus: OrderPaymentStatus; fulfilmentStatus: FulfilmentStatus; returnStatus: 'NONE'|'OPEN'|'CLOSED';
  displayStatus: string;               // derived, customer-friendly ("Payment processing", "Shipped", "Refunded")
  items: {...}[]; totals: {...}; shippingAddress: {...}; payment: { method: 'RAZORPAY'|'COD'; capturedAmount: Money; refundedAmount: Money };
  shipment: { courierName: string; awbNumber: string; trackingUrl: string | null } | null;
  timeline: { dimension: string; value: string; at: string }[];
  actions: { canCancel: boolean; canRetryPayment: boolean; canRequestReturn: boolean; canDownloadInvoice: boolean };
};
```

---

## 3. Storefront endpoints

### 3.1 Content & meta (public, cacheable)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/public` | Announcement bar, hero, home sections, free-shipping threshold, COD flags, social, store contact |
| GET | `/navigation` | Types → categories (active only) |
| GET | `/home` | `{hero, types[], newArrivals: ProductCard[≤8], reels[], techniques[], testimonials[], instagram[]}` |
| GET | `/reels`, `/testimonials`, `/faqs`, `/pages/:slug` | Content |
| GET | `/states?country=IN` | States |
| GET | `/pincodes/:pincode` | **Geography only**: `{pincode, city, district, state}` or 404 |
| GET | `/seo/sitemap-entries`, `/seo/resolve?path=` | Sitemap and redirect lookup |

### 3.2 Uncached public utilities
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pincodes/:pincode/serviceability` | `{serviceable, codAvailable, surfaceOnly, estimatedDays:{min,max}}`, from `pincode_serviceability` or the default policy |
| POST | `/newsletter/subscribe` | `{email, source}` → `201 SUBSCRIBED` / `200 ALREADY_SUBSCRIBED` |
| GET | `/newsletter/unsubscribe?token=` | Unsubscribe |
| POST | `/contact` | `{name, email, phone?, subject, message, orderNumber?}` |
| POST | `/custom-work` | `{name, email, phone, details{size, wood, quantity, budget, neededBy}, message, attachmentMediaIds[]}` (ids must be this cart's READY private uploads) |
| POST | `/uploads/presign` | Custom-work attachment (cart-cookie scope): `{filename, contentType, size}`; images only ≤ 8 MB, max 4 |
| POST | `/uploads/:mediaId/complete` | Same cart scope only |

Return photos are uploaded under the order routes so the order-scoped cookie (`Path=/v1/orders`) or the owner's Bearer token applies: `POST /me/orders/:n/uploads/presign` · `POST /orders/:n/uploads/presign` (guest), then `…/uploads/:mediaId/complete`.

### 3.3 Catalogue
| Method | Path | Description |
|--------|------|-------------|
| GET | `/types`, `/types/:slug`, `/categories/:slug`, `/techniques`, `/techniques/:slug` | Taxonomy (active only) |
| GET | `/products` | Listing (below). Only `ACTIVE` products with ≥ 1 active priced variant |
| GET | `/products/:slug` | Product detail; `{redirectTo}` for old slugs; 404 for DRAFT/ARCHIVED |
| GET | `/products/:slug/availability` | **no-store**: `{variants:[{id, price, mrp, stockStatus, maxQuantity}]}` |
| GET | `/products/:slug/related` | `{frequentlyBoughtTogether[], similar[]}` |
| GET | `/products/by-ids?ids=` | Cards (recently viewed, guest wishlist) |
| GET | `/search?q=…`, `/search/suggest?q=` | Search (logged) |

`GET /products` parameters: `type`, `category`, `technique` (slug lists), `q`, `minPrice`, `maxPrice`, `size`, `color`, `thickness` (lists), `inStock=1`, `sale=1`, `isNew=1`, `isTrending=1`, `sort` (`featured|newest|price_asc|price_desc|name_asc|best_selling|relevance`), `page`, `limit`.
**Variant filters (size, color, thickness, price, inStock, sale) must all be satisfied by the same variant** (architecture.md §6.2). Response: `{data: ProductCard[], meta, facets:{types, categories, techniques, sizes, colors, thicknesses, price:{min,max}}}`.

### 3.4 Customer auth (launch: email only)
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/auth/signup` | `{name, email, phone?, password, marketingOptIn}` → `201 {otpSentTo:"e***@gmail.com"}` (always the same shape, even if the email exists: an existing verified account instead receives a "someone tried to sign up" email) |
| POST | `/auth/signup/verify` | `{email, code}` → `{accessToken, user}` + refresh cookie; links verified-email guest orders; merges cart & wishlist |
| POST | `/auth/login` | `{email, password}` → `{accessToken, user}` + cookie. `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `NOT_VERIFIED` |
| POST | `/auth/otp/request` | `{email, purpose:'LOGIN'}` → always `{sent:true, resendAfter:30}` |
| POST | `/auth/otp/verify` | `{email, purpose:'LOGIN', code}` → tokens + cookie |
| POST | `/auth/refresh` | cookie only, body `{}` → `{accessToken, user}` (+ rotated cookie, or no cookie inside the grace window) |
| POST | `/auth/logout` | cookie → revoke + clear (identical attributes) |
| POST | `/auth/logout-all` | Bearer → revoke all |
| POST | `/auth/password/forgot` | `{email}` → `{ok:true}` always |
| POST | `/auth/password/reset` | `{token, password}` → `{ok:true}`; revokes all sessions |
| POST | `/auth/set-password` | `{token, password}` from the post-checkout email link → creates/activates a verified account, links guest orders, returns tokens |

`user = {id, name, email, emailVerified, phone, role, marketingOptIn}`.

### 3.5 Account (Bearer, audience storefront)
| Method | Path | Description |
|--------|------|-------------|
| GET/PATCH | `/me` | Profile; PATCH `{name, phone, marketingOptIn}` (phone is contact-only at launch) |
| POST | `/me/email/change` → `/me/email/verify` | OTP to the new email; notifies the old one; `aq_revoke_all_sessions` (both auth versions++, all sessions revoked; the client logs in again) |
| POST | `/me/password` | `{currentPassword, newPassword}` |
| DELETE | `/me` | `{password}` → soft delete (anonymised after 30 days; orders retained) |
| CRUD | `/me/addresses[/:id]`, `POST /me/addresses/:id/default` | Max 10 |
| GET | `/me/wishlist` · POST `/me/wishlist/toggle {productId}` · POST `/me/wishlist/merge {productIds[]}` | |
| GET | `/me/orders?status=&page=` | Summary list |
| GET | `/me/orders/:orderNumber` | `OrderView` |
| POST | `/me/orders/:orderNumber/cancel` | Idempotency-Key; `{reason}`; allowed while `PLACED/CONFIRMED` + `UNFULFILLED` |
| POST | `/me/orders/:orderNumber/returns` | Idempotency-Key; `{reason, description, items:[{orderItemId, quantity}], mediaIds[]}` |
| POST | `/me/orders/:orderNumber/reorder` | Adds available items to cart → `CartView` |
| GET | `/me/orders/:orderNumber/invoice` | 302 to a short-lived private URL (if issued) |
| GET | `/me/attachments/:mediaId` | 302 to a private URL if the media belongs to the user's order/return |

### 3.6 Guest order access
| Method | Path | Description |
|--------|------|-------------|
| GET | `/orders/track/:orderNumber?token=` | Read-only tracking view (token from email; masked address) |
| POST | `/orders/:orderNumber/access/request` | `{email}` → if it matches the order's contact email, sends an OTP. Always `{sent:true}` |
| POST | `/orders/:orderNumber/access/verify` | `{email, code}` → sets `__Secure-aq_order` (1 h, order-scoped); marks contact email verified |
| GET | `/orders/:orderNumber` | `OrderView` (requires the order cookie) |
| POST | `/orders/:orderNumber/cancel` · `/orders/:orderNumber/returns` | Idempotency-Key; same rules as account |
| GET | `/orders/:orderNumber/invoice` · `/orders/:orderNumber/attachments/:mediaId` | Private redirects |
| POST | `/orders/:orderNumber/payment/retry` | Idempotency-Key (op `payment.retry`); order cookie, cart cookie or owner Bearer → new Razorpay order details |

### 3.7 Cart (cart cookie; Bearer optional)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/cart` | `CartView` (re-priced live, quantities clamped to available) |
| POST | `/cart/items` | `{variantId, quantity}`; 409 `OUT_OF_STOCK` with `available` |
| PATCH / DELETE | `/cart/items/:itemId` | quantity 0 = remove |
| DELETE | `/cart` | Clear |
| POST / DELETE | `/cart/coupon` | `{code}`; validation only, **capacity is reserved at checkout** |
| GET | `/cart/coupons` | Public coupons with eligibility |
| POST | `/cart/estimate` | `{pincode, paymentMethod?}` → `CartView` with real shipping (or 422 not serviceable) |
| POST | `/cart/contact` | `{email, phone}` (unverified; checkout step 1) |

### 3.8 Checkout & payments
| Method | Path | Description |
|--------|------|-------------|
| POST | `/checkout/quote` | `{shippingAddressId | shippingAddress, paymentMethod}` → `CartView` + `codAvailable`, `codReason?` |
| POST | `/checkout/initiate` | **Idempotency-Key required.** Creates or returns the order (below) |
| POST | `/checkout/verify` | `{orderNumber, razorpayPaymentId, razorpaySignature}`. **`razorpay_order_id` from the client is ignored**: the server checks the signature against the stored provider order id, fetches the payment from Razorpay and calls the same `aq_apply_provider_payment` used by the webhook and reconciler. Response `200 {status:'PLACED'}` (also when the payment was already applied by the webhook) / `202 {status:'PROCESSING'}` (authorized, provider unreachable, or recorded `UNLINKED` because the provider order mapping is not saved yet; reconciliation recovers it) / `200 {status:'REVIEW'}` (held: amount/currency mismatch, partially refunded before apply, or identity conflict) / `200 {status:'PAYMENT_REFUNDED'}` (the payment was already fully refunded at the provider: the order is not placed) / `422 PAYMENT_VERIFICATION_FAILED` |
| GET | `/checkout/status/:orderNumber` | `{status, paymentStatus, displayStatus}` for polling; authorized by the cart cookie that created the order or the owner's Bearer (guests with order access use `GET /orders/:orderNumber`) |
| POST | `/checkout/payment-failed` | `{orderNumber, razorpayPaymentId?, error}`: informational log only, never changes state by itself |
| POST | `/webhooks/razorpay` | Signature on raw body; inbox semantics (architecture.md §8.1) |

**`POST /checkout/initiate`**
```json
{
  "contact": { "email": "hema@example.com", "phone": "+919876543210", "sendSetPasswordLink": true },
  "shippingAddressId": null,
  "shippingAddress": { "fullName": "Hema R", "phone": "+919876543210", "line1": "12, Rose Villa", "line2": "MG Road",
                       "landmark": "Near SBI", "city": "Kochi", "stateId": 18, "pincode": "682016", "label": "HOME", "save": true },
  "billingSameAsShipping": true, "billingAddress": null, "gstin": null, "businessName": null,
  "paymentMethod": "RAZORPAY",
  "customerNote": "Gift wrap please",
  "expectedTotal": 134900,
  "acceptTerms": true,
  "utm": { "source": "instagram", "medium": "social", "campaign": "launch" }
}
```
| Outcome | Status | Body |
|---------|--------|------|
| Prepaid, provider order created | 201 | `{orderNumber, status:'PENDING_PAYMENT', total, expiresAt, razorpay:{keyId, orderId, amount, currency, name, prefill}}` |
| Prepaid, provider definitively failed | 201 | `{orderNumber, status:'PENDING_PAYMENT', total, expiresAt, razorpay:null, retryPayment:true}` |
| Prepaid, provider outcome unknown | 202 | `{orderNumber, status:'PAYMENT_STARTING', retryAfter:3}` (repeat with the **same** key) |
| COD | 201 | `{orderNumber, status:'PLACED', total}` |
| Existing pending order for this cart | 200 | Same as the first row, for that order |
| Total changed | 409 | `PRICE_CHANGED` + `CartView` |
| Out of stock | 409 | `OUT_OF_STOCK` + lines |

---

## 4. Admin endpoints (`/admin/*`; audience admin; permission in brackets)

### 4.1 Admin auth & MFA
| Method | Path | Notes |
|--------|------|-------|
| POST | `/admin/auth/login` | `{email, password}` → `{challengeId, type:'MFA_LOGIN'|'MFA_ENROLL'}`. **Never returns tokens** |
| POST | `/admin/auth/mfa/enroll/start` | `{challengeId}` → `{otpauthUri, qrSvg}` |
| POST | `/admin/auth/mfa/enroll/confirm` | `{challengeId, code}` → `{recoveryCodes[10], accessToken}` + admin cookie |
| POST | `/admin/auth/mfa/verify` | `{challengeId, code}` or `{challengeId, recoveryCode}` → `{accessToken}` + cookie |
| POST | `/admin/auth/refresh` · `/admin/auth/logout` | Cookie (`Path=/v1/admin/auth`), Origin `https://admin.artq.in` |
| POST | `/admin/auth/step-up` | `{code}` → sets `mfa_verified_at` |
| POST | `/admin/me/recovery-codes/regenerate` | Step-up |
| GET | `/admin/me` | `{user, permissions[]}`: the SPA hides navigation and actions without permission, and the server enforces |

### 4.2 Dashboard & search
`GET /admin/dashboard?range=today|7d|30d` [dashboard:read] → `{revenue, orders, aov, newCustomers, salesSeries[], ordersByStatus, pendingActions:{toConfirm, toPack, toShip, returnsToDecide, openExceptions, restockRequests, messages}, lowStock[], topProducts[]}`.
`GET /admin/search?q=` → orders, products (by name/SKU) and customers, each filtered by the caller's permissions.

### 4.3 Products (screenshot module "Products") [catalog:read unless noted]
**`GET /admin/products`**: server-side listing for the Products page.

| Param | Values |
|-------|--------|
| `q` | name / SKU / slug search |
| `type` | type id, or `unassigned` (product tabs + **More** overflow are built from `GET /admin/product-types?withCounts=1`) |
| `status` | `DRAFT`, `ACTIVE`, `ARCHIVED` (multi) |
| `stock` | `in`, `low`, `out`, `oversold` |
| `readiness` | `ready`, `blocked`, or a specific check (`no_image`, `no_price`, `estimated_weight`, `stock_uncounted`, `no_tax`, `no_description`, `has_flags`) |
| `imageState` | `ready`, `processing`, `failed`, `missing` |
| `sort` | `name`, `updated_desc`, `price`, `stock` |
| `page`, `limit` | default 20 |

Row DTO:
```json
{ "serial": 21, "id": 42, "name": "Metallic Gold Gel Pigment", "slug": "metallic-gold-gel-pigment",
  "image": { "state": "READY|PROCESSING|FAILED|MISSING", "url": "https://cdn…/160.webp" },
  "type": { "id": 5, "name": "Pigments" },            // null ⇒ shown as "Unassigned" (never "Unknown")
  "category": { "id": 12, "name": "Gel Pigments" },
  "status": "DRAFT", "isPublishable": false, "readinessFailures": ["no_image", "estimated_weight"],
  "variantCount": 1, "priceRange": { "min": 9000, "max": 9000 }, "available": 20,
  "flags": ["SIZE_CONFLICT"], "updatedAt": "…", "version": 3 }
```
`serial` = (page − 1) × limit + row index, for the "#" column. The DTO maps `type` from the `type_id` relation. An unresolvable relation is a server bug, logged and reported as `type: null` with `typeMissing: true`, so it can be distinguished from a genuinely unassigned draft.

| Method | Path | Permission | Notes |
|--------|------|------------|-------|
| POST | `/admin/products` | catalog:write | Creates a **DRAFT**; variants without price allowed |
| GET | `/admin/products/:id` | catalog:read | Full editor payload incl. variants, images (with media state), readiness |
| PATCH | `/admin/products/:id` | catalog:write | Content fields only (`name`, `slug`, descriptions, lists, type/category, techniques, flags, ranks, SEO, relations); `version` required |
| PUT | `/admin/products/:id/images` | catalog:write + media | Ordered list `{mediaId, alt, isCover}`; only READY/PROCESSING media |
| POST | `/admin/products/:id/variants` · PATCH `/admin/variants/:id` | catalog:write | **Non-commercial** variant fields: size/net qty/unit, colour, hex, thickness, label, weight + source, dims, shipping class, image, barcode, sort, active |
| PATCH | `/admin/variants/:id/pricing` | **pricing:write** | `{price, mrp, costPrice, version}`; audited with before/after |
| POST | `/admin/products/:id/tax-approval` | catalog:publish | `{hsnCode, gstRate}`; sets `tax_approved_at/by` |
| GET | `/admin/products/:id/readiness` | catalog:read | Gate checklist |
| POST | `/admin/products/:id/publish` | **catalog:publish** | Activation toggle ON; 422 `NOT_PUBLISHABLE` with failures |
| POST | `/admin/products/:id/unpublish` | catalog:publish | Toggle OFF → `DRAFT` |
| POST | `/admin/products/:id/archive` | catalog:publish | Hidden; kept for history |
| DELETE | `/admin/products/:id` | catalog:write | **Delete** = hard delete only for drafts never referenced by orders/carts/imports; otherwise 409 with "Archive instead" |
| POST | `/admin/products/:id/duplicate` | catalog:write | New DRAFT, SKUs suffixed |
| POST | `/admin/products/bulk` | per action | `{ids[], action}`: `publish`/`unpublish`/`archive` (catalog:publish, per-item result), `markNew`/`unmarkNew`/`markTrending`/`unmarkTrending`/`setType`/`setCategory` (catalog:write) → `{results:[{id, ok, error?}]}` |

### 4.4 Product Types / Categories / Techniques (screenshot modules) [catalog:write]
CRUD `/admin/product-types`, `/admin/categories`, `/admin/techniques` (image media id, slug, description, sort, active, show on home/menu, tile link, SEO). `PATCH /admin/product-types/reorder {ids[]}`. Deleting a type/category with products → 409 (reassign or archive first).

### 4.5 Inventory [inventory:read / inventory:adjust]
| Method | Path | Notes |
|--------|------|-------|
| GET | `/admin/inventory?q=&stock=low|out|oversold&page=` | `{variantId, sku, product, onHand, reserved, available, lowStockThreshold, countedAt}` |
| POST | `/admin/inventory/adjustments` | `[{variantId, kind:'RECOUNT'|'ADJUSTMENT'|'DAMAGE_WRITE_OFF', quantity, note}]`. **Schema contains no price/MRP/status fields** (unknown keys → 400). RECOUNT sets `on_hand`; others apply a delta; `reserved` is never written |
| GET | `/admin/inventory/:variantId/movements` | Ledger incl. reservations |
| POST | `/admin/imports` (kind `INVENTORY`) | Counted-stock sheet (§4.9) |

### 4.6 Orders (screenshot module "Orders") [orders:*]
| Method | Path | Permission | Notes |
|--------|------|------------|-------|
| GET | `/admin/orders?status=&paymentStatus=&fulfilmentStatus=&method=&exception=1&from=&to=&q=&page=` | orders:read | Server-side filters |
| GET | `/admin/orders/:id` | orders:read | Items, customer (masked for STAFF), addresses, attempts, payments, refunds, exceptions, shipment, invoices, history, emails |
| POST | `/admin/orders/:id/confirm` · `/pack` · `/ship` · `/out-for-delivery` · `/deliver` · `/rto` · `/rto-received` · `/lost` | orders:fulfil | `ship {courierName, awbNumber, trackingUrl, weightG}`; `rto-received {items:[{orderItemId, sellableQty, damagedQty}]}`; transitions validated (database.md §4.3) |
| POST | `/admin/orders/:id/cancel` | orders:cancel | Idempotency-Key; `{reason, notifyCustomer}` → releases stock; prepaid ⇒ refund created automatically |
| PATCH | `/admin/orders/:id` | orders:fulfil | Shipping-address correction (only `UNFULFILLED`), admin note; `version` |
| GET | `/admin/orders/:id/packing-slip` · `/invoice` · `/credit-notes/:invoiceId` | orders:read | Private PDF redirects |
| POST | `/admin/orders/:id/resend-email` | orders:fulfil | `{template}`; new dedupe key suffix `:resend:<n>` |

### 4.7 Refunds, returns, COD (MVP) 
| Method | Path | Permission | Notes |
|--------|------|------------|-------|
| GET | `/admin/orders/:id/refundable` | refunds:create | Per item `{quantity, netAmount, reservedQty, reservedAmount, refundedQty, refundedAmount, availableQty, availableAmount}`; order `{shipping:{fee, reserved, available}, codFee:{…}, total:{cap, reserved, refunded, available}}`; payment `{amount, reserved, refunded, available}`. "Reserved" includes `REQUESTED`/`PENDING`/`UNKNOWN`/`PROCESSED` refunds |
| POST | `/admin/orders/:id/refunds` | refunds:create + step-up | Idempotency-Key (target `order:<number>`); `{kind, items:[{orderItemId, quantity, amount}], shippingAmount, codFeeAmount, reason, returnRequestId?}` → `201 {refundId, status:'REQUESTED', attempt:{no:1, receipt}}` (COD: `MANUAL_BANK`, no attempt); 409 `REFUND_EXCEEDS_CAPACITY` with `details.scope` |
| POST | `/admin/refunds/:id/manual-processed` | refunds:create + step-up | COD only: `{manualReference}` → `PROCESSED` |
| GET | `/admin/refunds?status=` | refunds:create | Queue incl. `UNKNOWN`/`FAILED`, attempts with key, receipt, last HTTP status |
| POST | `/admin/refunds/:id/retry` | refunds:create + step-up | Only `FAILED`. Reacquires capacity, then creates attempt n+1 with a **new** `X-Refund-Idempotency` key and receipt → `202 {attempt:{no, receipt}}`; 409 `REFUND_EXCEEDS_CAPACITY` if a newer refund used the capacity (refund stays `FAILED`); 409 `REFUND_NOT_RETRYABLE` otherwise. `UNKNOWN` refunds are not retried by staff: the reconciler resends the same attempt |
| POST | `/admin/refunds/:id/cancel` | refunds:create | Only **manual (COD)** refunds still `REQUESTED` → `CANCELLED`, capacity released (`aq_cancel_manual_refund`). Online refunds cannot be cancelled once requested (a provider call may be in flight); their capacity is released only by a definitive `FAILED` result → 409 `REFUND_NOT_CANCELLABLE` |
| GET | `/admin/returns?status=` · `/admin/returns/:id` | returns:receive | |
| POST | `/admin/returns/:id/decide` | returns:decide | `{decision:'APPROVE'|'REJECT', items:[{orderItemId, approvedQty}], note}` |
| POST | `/admin/returns/:id/in-transit` · `/receive` · `/inspect` | returns:receive | `receive {items:[{orderItemId, receivedQty}]}`; `inspect {items:[{orderItemId, sellableQty, damagedQty}]}` (restocks sellable) |
| POST | `/admin/returns/:id/close` | returns:decide | |
| POST | `/admin/cod-remittances` | cod:remit | `{courierName, reference, remittedAt, amount, orders:[{orderNumber, amount}]}` → mismatches reported |
| GET | `/admin/cod-remittances` · `/admin/cod/outstanding` | cod:remit | |

### 4.8 Customers, Coupons, Shipping Rates, Restock Requests (screenshot modules)
| Resource | Endpoints | Permission |
|----------|-----------|------------|
| Customers | `GET /admin/customers?q=&page=`, `GET /admin/customers/:id` (orders, addresses, notes; contact masked for STAFF), `POST /admin/customers/:id/block` / `unblock` (revokes sessions), `PATCH /admin/customers/:id {adminNotes}` | customers:read / customers:write |
| Coupons | CRUD `/admin/coupons` (value, type, limits, window, scope targets, public flag); `GET /admin/coupons/:id/redemptions` (status, order, customer). Editing `value`/`type` of a coupon with redemptions → 409 (create a new coupon) | coupons:write |
| Shipping Rates | `GET/PUT /admin/shipping/zones` (zones, `extraPerKg`, slabs, state mapping); `PUT /admin/settings/SHIPPING`; CRUD `/admin/shipping/serviceability` (pincode rules, CSV import); `POST /admin/shipping/preview {pincode, lines}` → shipping breakdown | shipping:write |
| Restock Requests | `GET /admin/restock-requests?groupBy=variant&status=` → `{variant, product, pending, oldestAt, available}`; `POST /admin/restock-requests/notify {variantId}` (only when available > 0; idempotent per variant/day); `DELETE /admin/restock-requests/:id` | restock:read / restock:notify |

### 4.9 Imports, media, content
| Resource | Endpoints | Permission |
|----------|-----------|------------|
| Imports | `POST /admin/imports {kind:'CATALOG'|'INVENTORY', fileMediaId}` → validation job; `GET /admin/imports/:id` (status, counts); `GET /admin/imports/:id/rows?status=` (row outcomes, messages); `POST /admin/imports/:id/confirm`; `POST /admin/imports/:id/cancel`; `POST /admin/imports/:id/rows/:rowId/resolve {action:'apply'|'skip'}` for `NEEDS_REVIEW`; `GET /admin/imports/:id/result.xlsx`; `GET /admin/imports/template.xlsx?kind=`; `GET /admin/exports/catalog.xlsx` | imports:catalog (+ pricing:write if price columns change) / inventory:adjust |
| Media | `POST /admin/media/presign`, `POST /admin/media/:id/complete`, `POST /admin/media/:id/retry` (FAILED only), `GET /admin/media?kind=&status=&unused=1`, `DELETE /admin/media/:id` (409 if referenced) | media:write |
| CMS | CRUD `/admin/home-slides`, `/admin/reels`, `/admin/testimonials`, `/admin/faqs`, `/admin/pages`; `PUT /admin/settings/{ANNOUNCEMENT_BAR|HOME_SECTIONS|HERO|INSTAGRAM_MOMENTS|SOCIAL}`; `GET/PATCH /admin/messages`; `GET /admin/newsletter` + CSV export (step-up) | content:write |

### 4.10 Operations: exceptions, jobs, staff, settings, audit
| Resource | Endpoints | Permission |
|----------|-----------|------------|
| Payment exceptions | `GET /admin/payment-exceptions?status=&type=`; `GET /:id`; `POST /:id/resolve {resolution, note}`; `POST /:id/dismiss {note}`; `POST /admin/payments/reconcile {orderId? | from,to}` (manual run) | payments:exceptions |
| Jobs & webhooks | `GET /admin/ops/summary` (queue depths, failed counts, inbox status counts, outbox backlog, last scheduler runs); `GET /admin/ops/webhooks?status=`; `POST /admin/ops/webhooks/:id/retry` (DEAD/FAILED → RECEIVED); `GET /admin/ops/outbox-deliveries?status=&consumer=` (PENDING/LEASED/PUBLISHED-not-completed/DEAD with generation, last error); `POST /admin/ops/outbox-deliveries/:id/retry` (DEAD → PENDING, generation reset); `GET /admin/ops/jobs/failed`; `POST /admin/ops/jobs/:id/retry` | jobs:read / jobs:retry |
| Staff & permissions | CRUD `/admin/staff` (role changes revoke admin sessions); `POST /admin/staff/:id/reset-mfa` (step-up); `POST /admin/staff/:id/revoke-sessions` | staff:manage |
| Settings | `GET /admin/settings`; `PUT /admin/settings/:key` (STORE_INFO, PAYMENT toggles, ORDER, TAX, NOTIFY; step-up) | settings:write |
| Audit logs | `GET /admin/audit-logs?entity=&entityId=&actor=&action=&from=&to=` | audit:read |

---

## 5. Webhooks (incoming)
**Razorpay** `POST /v1/webhooks/razorpay`: architecture.md §8.1. Handled events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`, `refund.failed`. Others → `IGNORED`. The handler always re-fetches the authoritative object before applying.
**Courier** (post-launch, Shiprocket): same inbox pattern (`provider = 'SHIPROCKET'`).

---

## 6. Rate limits
| Scope | Limit |
|-------|-------|
| `/auth/login`, `/admin/auth/login` | 10/min/IP; 5 failures → 15-min account lock |
| `/admin/auth/mfa/*` | 5 attempts per challenge; 20/min/IP |
| `/auth/otp/request`, `/orders/:n/access/request` | 5/hour/target, 20/hour/IP, 30 s cooldown |
| OTP verify | 5 attempts per code |
| `/auth/refresh` | 30/min/session |
| `/checkout/*`, `/orders/:n/payment/retry` | 20/min/cart |
| `/contact`, `/custom-work`, `/newsletter/subscribe`, `/uploads/presign` | 5/min/IP |
| `/search/suggest` | 60/min/IP |
| Default | 300/min/IP; admin 600/min/user |
