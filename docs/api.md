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
`VALIDATION_ERROR` 400 · `UNAUTHENTICATED` 401 · `SESSION_INVALID` 401 · `INVALID_CREDENTIALS` 401 · `STEP_UP_REQUIRED` 401 · `FORBIDDEN` 403 · `NOT_VERIFIED` 403 · `ACCOUNT_BLOCKED` 403 · `ORIGIN_REJECTED` 403 · `ACCOUNT_EXISTS` 409 (set-password link for an email that already has a password) · `TOKEN_INVALID` 422 (reset / set-password link invalid, used or expired) · `NOT_FOUND` 404 · `VERSION_CONFLICT` 409 · `OUT_OF_STOCK` 409 · `PRICE_CHANGED` 409 · `REQUEST_IN_PROGRESS` 409 · `REQUEST_SUPERSEDED` 409 · `REFUND_EXCEEDS_CAPACITY` 409 (`details.scope` = `item` (+ `orderItemId`) / `order` / `payment`) · `REFUND_NOT_RETRYABLE` 409 · `REFUND_RECONCILIATION_REQUIRED` 409 (provider refunds on the payment not yet reconciled) · `REFUND_NOT_CANCELLABLE` 409 · `IDEMPOTENCY_KEY_REUSED` 422 · `COUPON_INVALID` / `COUPON_EXPIRED` / `COUPON_MIN_ORDER` / `COUPON_USAGE_EXCEEDED` / `COUPON_NOT_ELIGIBLE` 422 · `COUPON_IN_USE` 409 · `ZONE_IN_USE` 409 · `COD_NOT_AVAILABLE` 422 · `PINCODE_NOT_SERVICEABLE` 422 · `SHIPPING_RESTRICTED` 422 · `NOT_PUBLISHABLE` 422 · Staff: `STAFF_EXISTS` / `LAST_SUPER_ADMIN` 409 · `CANNOT_CHANGE_SELF` 422 · Catalogue: `MEDIA_NOT_USABLE` / `RELATION_SELF` / `RELATION_NOT_FOUND` 422 · `UNPUBLISH_FIRST` / `TAXONOMY_IN_USE` / `NAME_TAKEN` 409 (a change would make a live product fail a publication check; `details.failures`) · `SLUG_TAKEN` / `SKU_EXISTS` / `VARIANT_OPTIONS_EXIST` / `ARCHIVE_INSTEAD` (`details.reason`) 409 · `CATEGORY_TYPE_MISMATCH` / `TAXONOMY_NOT_FOUND` / `MEDIA_NOT_FOUND` / `SIZE_INVALID` / `DIMENSIONS_INCOMPLETE` / `MRP_BELOW_PRICE` / `FLAGS_ADD_FORBIDDEN` 422 · `INVALID_TRANSITION` 422 · `RETURN_NOT_ALLOWED` 422 · `OTP_INVALID` / `OTP_EXPIRED` / `MFA_INVALID` 422 · `PAYMENT_VERIFICATION_FAILED` 422 · `ACCOUNT_LOCKED` 423 · `RATE_LIMITED` 429 · `PAYMENT_PROVIDER_UNAVAILABLE` 503 · `INTERNAL` 500.

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

**Other cases** (implemented in `apps/api/src/idempotency/idempotency.ts`): a missing or non-UUID key → 400 `VALIDATION_ERROR` (`details[0].location = 'headers'`); keys are compared case-insensitively. A business error (4xx such as `OUT_OF_STOCK`) is stored as the key's response, so a retry with the same key receives the same answer. An unexpected failure (5xx) **before any resource was attached** deletes the key (fenced by the token), so an immediate retry runs; after a resource was attached the key stays `PROCESSING`, the retry gets `REQUEST_IN_PROGRESS` until the lock expires and then takes over and resumes the resource.

Records expire after 24 h (hourly retention job). Business-level dedupe also applies: at most one `PENDING_PAYMENT` order per cart, one open payment attempt per order, refund `idempotency_key` unique per order. Provider-facing idempotency is separate: refund attempts carry their own `X-Refund-Idempotency` key (architecture.md §10.2).

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
  items: { id: number; variantId: number; productId: number; productSlug: string; productName: string; variantLabel: string;
           image: MediaRef | null; unitPrice: Money; unitMrp: Money | null; quantity: number; lineTotal: Money;
           maxQuantity: number; available: boolean; priceChanged: boolean; warning?: string }[];
  coupon: { code: string; title: string; summary: string; type: 'PERCENT' | 'FLAT' | 'FREE_SHIPPING'; applied: boolean;
            discount: Money; freeShipping: boolean; problem: { code: string; message: string; shortBy?: Money } | null } | null;
  totals: { itemCount: number; subtotal: Money; mrpTotal: Money; mrpDiscount: Money; couponDiscount: Money;
            // With ?pincode=: amount (included in total) or problem (UNKNOWN_PINCODE | NO_ZONE | PINCODE_NOT_SERVICEABLE |
            // SHIPPING_RESTRICTED | DIMENSIONS_REQUIRED | NO_RATE); without: amount null, estimated true.
            shipping: { amount: Money | null; estimated: boolean; freeApplied: boolean; heavySurcharge: Money;
                        pincode: string | null; problem: string | null };
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
| GET | `/settings/public` | `PublicSettings` (`@artq/shared`): `{store:{name, phone, email, whatsapp}, announcement:{enabled, messages}, social, shipping:{freeThreshold, estimatedDays}, payment:{codEnabled, codFee, codMin, codMax}, order:{returnWindowHours}, home:{order, hidden, heroSlideIntervalMs, instagram}}`. Only `is_public` settings; a stored value that fails its schema is served as the default (and logged). Never GSTIN, legal name, address or private settings |
| GET | `/navigation` | `{types:[{id, name, slug, href, categories:[{id, name, slug}]}]}`: active types with *show in menu*, their active categories, both in admin order; `href` = the type's tile link override or `/type/:slug` |
| GET | `/home` | `HomeView` (`@artq/shared`): `{sections, hero:{slides, intervalMs}, types[], newArrivals: ProductCard[≤8], trending: ProductCard[≤8], reels[], techniques[], testimonials[], instagram:{handle, url}}`. `sections` = the `HOME_SECTIONS` order without hidden or empty sections (`reels` is "Trending now"; `trending` is its product-grid fallback, listed only without reels). Only `ACTIVE` products and `READY` public media; New Arrivals = flagged by rank, then newest published; techniques only with live products; a reel/testimonial links its product only while it is live; a video hero slide uses its second image as poster |
| GET | `/reels`, `/testimonials`, `/faqs`, `/pages/:slug` | Content |
| GET | `/states?country=IN` | States |
| GET | `/pincodes/:pincode` | **Geography only**: `{pincode, city, district, state}` or 404 |
| GET | `/seo/sitemap-entries`, `/seo/resolve?path=` | Sitemap and redirect lookup |

### 3.2 Uncached public utilities
| Method | Path | Description |
|--------|------|-------------|
| GET | `/pincodes/:pincode/serviceability` | `PincodeCheck` `{pincode, place:{district,state}\|null, serviceable, codAvailable, surfaceOnly, surfaceAvailable (false in an air-only area, D-7), estimatedDays:{min,max}\|null, reason:'UNKNOWN_PINCODE'\|'NOT_SERVICEABLE'\|null}`: an explicit `pincode_serviceability` row, else the default policy (D-6); a pincode in neither the postal directory nor the rules → `UNKNOWN_PINCODE` (probably mistyped). 400 "Enter a 6-digit pincode" (`pincodeField`) |
| POST | `/newsletter/subscribe` | `{email, source?:'footer'|'checkout'|'account'}` (`newsletterSubscribeBody`) → `201 {status:'SUBSCRIBED'}` (new, or previously unsubscribed) / `200 {status:'ALREADY_SUBSCRIBED'}`; email case-insensitive; 5/min per IP (task 3.1) |
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
| GET | `/products/:slug` | `ProductDetail` (`@artq/shared`): active variants with a price (cheapest first), `options` only for dimensions with more than one value (Size → Colour → Thickness), images; **no stock** (cacheable). `{redirectTo}` for old slugs; 404 for DRAFT/ARCHIVED |
| POST | `/products/:slug/notify` | "Notify me" `{variantId, email}` (`notifyMeBody`) → `201 SUBSCRIBED` / `200 ALREADY_SUBSCRIBED` (one pending request per size and email); 409 `IN_STOCK` while that size can be bought; 5/min per IP |
| GET | `/products/:slug/availability` | **no-store**: `{variants:[{id, price, mrp, discountPercent, stockStatus, maxQuantity}]}`; `LOW_STOCK` when available ≤ the variant's low-stock threshold; `maxQuantity` = min(available, 50) |
| GET | `/products/:slug/related` | `{frequentlyBoughtTogether[], similar[]}`: products in the same paid orders (most often first, ≤ 4) and live products of the same category, then the same type (≤ 8); cacheable |
| GET | `/products/by-ids?ids=` | Cards in the order asked (`ids` = up to 24 comma-separated ids; only live products) |
| GET | `/search?q=…`, `/search/suggest?q=` | `/search`: the listing parameters with a required `q`; `SearchResults` = `ProductList` + `{query, suggestion}` (closest product name by trigram word similarity when nothing matched); page 1 logged in `search_logs` (query, normalised, result count; a logging failure never fails the search); no-store. `/search/suggest` (`q` 2–100 chars, 60/min per IP): `{products ≤ 6 (word prefix, name or close spelling), types ≤ 3, categories ≤ 3}` (only with live products) |

`GET /products` parameters: `type`, `category`, `technique` (slug lists), `q`, `minPrice`, `maxPrice`, `size`, `color`, `thickness` (lists), `inStock=1`, `sale=1`, `isNew=1`, `isTrending=1`, `sort` (`featured|newest|price_asc|price_desc|name_asc|best_selling|relevance`), `page`, `limit`.
**Variant filters (size, color, thickness, price, inStock, sale) must all be satisfied by the same variant** (architecture.md §6.2). Response: `{data: ProductCard[], meta, facets:{types, categories, techniques, sizes, colors, thicknesses, price:{min,max}}}`.
Implemented in task 3.5 (`storefrontListQuery` in `@artq/shared`, strict: unknown parameters → 400): lists are repeated parameters (`?size=10 gm&size=50 gm`, ≤ 20 values, OR within a list, AND across); `minPrice`/`maxPrice` in paise (inclusive; max ≥ min); flags `1`/`true`; `limit` ≤ 96 (default 24), `page` ≤ 200; `sort` default `featured` (`relevance` with `q`, required for it). `q` matches word prefixes (`mica gol`) or the name. `best_selling` = units in paid orders of the last 90 days. Facets are `{value, label, count, hex?}`; each counts with every other filter applied (same-variant rule); a selected value that matches nothing is still listed with count 0. The storefront URL uses whole rupees (`min`, `max`) and converts. `GET /types/:slug` · `/categories/:slug` · `/techniques/:slug` → `TaxonomyPage` `{kind, name, slug, description, banner, metaTitle, metaDescription, parent, children}` (a type's children: its active categories with live products); `{redirectTo}` for renamed slugs; 404 when inactive (a category also when its type is off).

### 3.4 Customer auth (launch: email only)
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/auth/signup` | `{name, email, phone?, password (≥ 8 with a letter and a number, as every new customer password: reset, set-password, change), marketingOptIn}` → `201 {otpSentTo:"e***@gmail.com"}` (always the same shape, even if the email exists: an existing verified account instead receives a "someone tried to sign up" email) |
| POST | `/auth/signup/verify` | `{email, code}` → `{accessToken, user}` + refresh cookie; links verified-email guest orders; merges cart & wishlist |
| POST | `/auth/login` | `{email, password}` → `{accessToken, user}` + cookie. `INVALID_CREDENTIALS` (same response for unknown email and wrong password), `ACCOUNT_LOCKED` (`details.retryAfterSeconds`), `NOT_VERIFIED` / `ACCOUNT_BLOCKED` (only after a correct password) |
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
| GET | `/me/wishlist` · POST `/me/wishlist/toggle {productId}` · POST `/me/wishlist/merge {productIds[]}` | Newest first, at most 100 (a new save past 100 drops the oldest); `{productIds, data: ProductCard[]}` (cards only for live products) |
| GET | `/me/orders?status=&page=` | Summary list |
| GET | `/me/orders/:orderNumber` | `OrderView` |
| POST | `/me/orders/:orderNumber/cancel` | Idempotency-Key; `{reason}`; allowed while `PLACED/CONFIRMED` + `UNFULFILLED` |
| POST | `/me/orders/:orderNumber/returns` | Idempotency-Key; `{reason, description, items:[{orderItemId, quantity}], mediaIds[]}` |
| POST | `/me/orders/:orderNumber/reorder` | Adds available items to cart → `CartView` |
| GET | `/me/orders/:orderNumber/invoice` | 302 to a short-lived private URL (if issued) |
| GET | `/me/attachments/:mediaId` | 302 to a private URL if the media belongs to the user's order/return |

Implemented in task 4.2 (bodies in `@artq/shared` auth-schemas, shared with the forms): password-checking routes (`/me/password`, `/me/email/*`, `DELETE /me`) share the per-IP login limit and the account lockout; a wrong password is a 400 `VALIDATION_ERROR` on the password field, so the form shows it under that field. Password change, email change and deletion revoke every session and clear the refresh cookie. Email change: `{newEmail, password}` → `{otpSentTo}` (masked); a taken or unchanged address is a field error; `{code}` → `{ok, email}` (409 `EMAIL_TAKEN` if someone claimed it meanwhile). `DELETE /me` `{password, confirm: true}`; the email can sign up again at once; after 30 days the retention job removes addresses and wishlist and blanks name, phone, password and email. Addresses: the first is the default, deleting the default promotes the most recently updated one, the 11th → 422 `ADDRESS_LIMIT` (serialised per user), another user's id → 404; an inactive state → field error on `stateId`, a pincode the postal directory places in another state → `This pincode is in <State>` on `pincode`. Helpers (public, cacheable): `GET /states` (active Indian states by name), `GET /pincodes/:pincode` → `{pincode, district, state}` or 404 (address autofill). Cart at sign-in (rest of 4.1): every sign-in route claims the guest cart cookie: with no account cart the guest cart becomes it, else its lines are added (quantity summed, capped at 50 and at stock) and it is marked `MERGED`; a failure never fails the sign-in. `/cart` with a Bearer uses the account cart on any device; an invalid Bearer → 401 (the client refreshes); the cookie alone never opens an account cart.

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
| GET | `/cart` | `CartView` (re-priced live, quantities clamped to available). Every cart call accepts `?pincode=` (6 digits; other query keys → 400): the shipping for that pincode through the one algorithm is quoted and added to `total` (task 4.5) |
| POST | `/cart/items` | `{variantId, quantity 1–50}` (`cartAddBody`); the first add creates the cart and its cookie. Merges with the same variant; 409 `OUT_OF_STOCK` `{available, inCart}` (available = on hand − reserved; carts never reserve); 422 `QUANTITY_LIMIT` above 50 per line; 404 for drafts/inactive/unknown. Every cart response is the re-priced `CartView`: quantities above stock are lowered and saved with a warning, sold-out and unpublished lines stay listed but are not counted, a price change is flagged once (task 3.4; merge on login with 4.2) |
| PATCH / DELETE | `/cart/items/:itemId` | quantity 0 = remove |
| DELETE | `/cart` | Clear |
| POST / DELETE | `/cart/coupon` | `{code}` (case-insensitive) → `CartView`; validation only, **capacity is reserved at checkout**. Refused with the first failing check (product.md §8.4): `COUPON_INVALID` (unknown, off, not started), `COUPON_EXPIRED`, `COUPON_USAGE_EXCEEDED` (used up, or by this customer: account, or the email once given at checkout), `COUPON_NOT_ELIGIBLE` (first order only, no eligible items, empty cart), `COUPON_MIN_ORDER` (`details.shortBy`, eligible items only); the cart keeps its previous coupon. 10/min/IP |
| GET | `/cart/coupons` | Public coupons (active, in window, not used up; newest 20) → `{data: [{code, title, description, type, value, maxDiscount, minOrderValue, endsAt, eligible, reason}]}` for this cart |

The cart's coupon is re-checked on every read: one that stops qualifying stays on the cart as `coupon: {…, applied: false, discount: 0, problem: {code, message, shortBy?}}` and applies again by itself when the cart qualifies; a deleted coupon is dropped. `CartView.coupon` = `{code, title, summary, type, applied, discount, freeShipping, problem}`; free-shipping progress counts the coupon (`subtotal − couponDiscount`). Implemented in task 4.3.
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

### 4.1 Admin auth (MFA deferred)
**Status 2026-10-02:** the owner deferred MFA. Until it ships, admin login is email + password and step-up is a password
re-check. The MFA endpoints below the table remain the target design (tasklist 1.6b).

| Method | Path | Notes |
|--------|------|-------|
| POST | `/admin/auth/login` | `{email, password}` → `{accessToken, user}` + admin cookie. Staff roles only; a customer account, wrong password and unknown email all return the same 401 `INVALID_CREDENTIALS`; shared lockout (`ACCOUNT_LOCKED`); `ACCOUNT_BLOCKED`. Audited (`admin.login`) |
| POST | `/admin/auth/refresh` · `/admin/auth/logout` | Cookie `__Secure-aq_admin_rt` (`Path=/v1/admin/auth`, 12 h idle / 7 d absolute), Origin from `ADMIN_ORIGINS`; same rotation, grace and reuse rules as the storefront |
| POST | `/admin/auth/logout-all` | Bearer (admin) → revoke all sessions |
| POST | `/admin/auth/step-up` | Bearer (admin), `{password}` → `{stepUpUntil}` (10 min, this session only); wrong passwords count toward the lockout. Audited (`admin.step_up`) |
| POST | `/admin/auth/password/forgot` | `{email}` → always `{ok:true}`; a 30-min link to `<admin origin>/reset-password` is emailed only to an ACTIVE staff account (per-IP `emailSend` limit; ≤ 5 links per account per hour) |
| POST | `/admin/auth/password/reset` | `{token, password ≥ 12}` → `{ok:true}`; used by reset **and staff invite** links; ends every session. (The storefront reset also enforces 12 characters for staff accounts.) |
| GET | `/admin/me` | `{user}` (task 1.7 adds `permissions[]`): the SPA hides navigation and actions without permission, and the server enforces |

Target MFA endpoints (deferred): `POST /admin/auth/login` → `{challengeId, type:'MFA_LOGIN'|'MFA_ENROLL'}` (no tokens); `POST /admin/auth/mfa/enroll/start` `{challengeId}` → `{otpauthUri, qrSvg}`; `POST /admin/auth/mfa/enroll/confirm` `{challengeId, code}` → `{recoveryCodes[10], accessToken}` + cookie; `POST /admin/auth/mfa/verify` `{challengeId, code | recoveryCode}` → `{accessToken}` + cookie; step-up `{code}`; `POST /admin/me/recovery-codes/regenerate` (step-up).

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
| `readiness` | `ready`, `blocked`, or one failing check, by the codes of `product_readiness_failures()` (`taxonomy`, `no_description`, `no_tax`, `has_flags`, `no_image`, `no_active_variant`, `no_price_or_size`, `stock_uncounted`, `shipping_data`, `variant_flags`) |
| `imageState` | `ready`, `processing`, `failed`, `missing` |
| `flag` | an import flag on the product or any of its variants |
| `sort` | `name`, `updated_desc`, `price` (unpriced last), `stock` (lowest first) |
| `page`, `limit` | default 20 |

Row DTO:
```json
{ "serial": 21, "id": 42, "name": "Metallic Gold Gel Pigment", "slug": "metallic-gold-gel-pigment",
  "image": { "state": "READY|PROCESSING|FAILED|MISSING", "url": "https://cdn…/160.webp" },
  "type": { "id": 5, "name": "Pigments" },            // null ⇒ shown as "Unassigned" (never "Unknown")
  "category": { "id": 12, "name": "Gel Pigments" },
  "status": "DRAFT", "isPublishable": false, "readinessFailures": ["no_image", "estimated_weight"],
  "variantCount": 1, "priceRange": { "min": 9000, "max": 9000 }, "available": 20,
  "activeVariantCount": 1, "lowStock": false, "oversold": false, "deletable": true,
  "flags": ["SIZE_CONFLICT"], "updatedAt": "…", "version": 3 }
```
`serial` = (page − 1) × limit + row index, for the "#" column. The DTO maps `type` from the `type_id` relation (a foreign key, so it always resolves); `type: null` means a genuinely unassigned draft, shown as "Unassigned". `readinessFailures` is evaluated live; `deletable` = a draft never ordered, carted, imported or stock-counted (else the row offers Archive). Query schema: `productListQuery` in `@artq/shared`. Type tabs: `GET /admin/product-types?withCounts=1` → `{data:[{…, productCount}], unassigned, total}`; `GET /admin/categories?typeId=` for filters and bulk Set category.

| Method | Path | Permission | Notes |
|--------|------|------------|-------|
| POST | `/admin/products` | catalog:write | Creates a **DRAFT**; variants without price allowed |
| GET | `/admin/products/:id` | catalog:read | Full editor payload incl. variants, images (with media state), readiness |
| PATCH | `/admin/products/:id` | catalog:write | Content fields only (`name`, `slug`, descriptions, lists, type/category, techniques, flags, ranks, SEO, `relations:[{productId, kind}]` replacing the set; 422 `RELATION_SELF` / `RELATION_NOT_FOUND`); `description` is rich text sanitised server-side (empty markup = no description); `version` required. `version` guards the content fields only: images, variants, prices, tax approval and publication do not bump it. The editor payload adds `relations[]` (with names) and `updatedBy {id, name, email}` for the conflict message |
| PUT | `/admin/products/:id/images` | catalog:write + media:write | `{images:[{mediaId, alt, isCover}]}`, ordered, ≤ 20, exactly one cover; only this pipeline's PUBLIC images that are UPLOADED/PROCESSING/READY (else 422 `MEDIA_NOT_USABLE` with `details.mediaIds`); claims the media; a live product must keep a ready cover (409 `UNPUBLISH_FIRST`) |
| POST | `/admin/products/:id/variants` · PATCH `/admin/variants/:id` | catalog:write | **Non-commercial** variant fields: size/net qty/unit, colour, hex, thickness, label, weight + source, dims, shipping class, image, barcode, sort, active |
| PATCH | `/admin/variants/:id/pricing` | **pricing:write** | `{price, mrp, costPrice, version}`; audited with before/after |
| POST | `/admin/products/:id/tax-approval` | catalog:publish | `{hsnCode, gstRate}`; sets `tax_approved_at/by` |
| GET | `/admin/products/:id/readiness` | catalog:read | `{ready, failures:[{code, check, fix}]}`, evaluated live by `product_readiness_failures()`; labels in `@artq/shared` `READINESS` |
| POST | `/admin/products/:id/publish` | **catalog:publish** | Activation toggle ON (DRAFT/ARCHIVED → ACTIVE); 422 `NOT_PUBLISHABLE` with `details.failures` (the evaluation is stored either way); already ACTIVE = no change; `published_at` keeps the first publication. While ACTIVE every catalogue change is re-checked in its transaction → 409 `UNPUBLISH_FIRST`; a variant added to an ACTIVE product starts inactive |
| POST | `/admin/products/:id/unpublish` | catalog:publish | Toggle OFF → `DRAFT` |
| POST | `/admin/products/:id/archive` | catalog:publish | Hidden; kept for history |
| DELETE | `/admin/products/:id` | catalog:write | **Delete** = hard delete only for drafts never referenced by orders/carts/imports; otherwise 409 with "Archive instead" |
| POST | `/admin/products/:id/duplicate` | catalog:write | New DRAFT, SKUs suffixed |
| POST | `/admin/products/bulk` | per action | `{ids[], action}`: `publish`/`unpublish`/`archive` (catalog:publish, per-item result), `markNew`/`unmarkNew`/`markTrending`/`unmarkTrending`/`setType`/`setCategory` (catalog:write) → `{results:[{id, ok, error?}]}` |

### 4.4 Product Types / Categories / Techniques (screenshot modules) [catalog:write]
CRUD `/admin/product-types`, `/admin/categories`, `/admin/techniques` (image media id, slug, description, sort, active, show on home/menu, tile link, SEO; categories also `typeId`, default HSN / GST). Lists take `?withCounts=1` (types: `productCount`, `categoryCount`, Unassigned, All; categories/techniques: `productCount`); `GET …/:id` returns the record with `media` and `usage`. Slug from the name when omitted (next free), 301s on change (entities `type` / `category` / `technique`). `PATCH …/reorder {ids[]}` for all three (sort order = list order). Images must be usable product images (422 `MEDIA_NOT_USABLE`). Delete refused while used (types: products or categories; categories: products, archived included; techniques: products) → 409 `TAXONOMY_IN_USE` with `details {products, categories?}` and the guidance in `message` (move/archive first, or turn it off). Moving a category to another type while products use it → 409 `TAXONOMY_IN_USE`; duplicate category name within a type → 409 `NAME_TAKEN`. Schemas in `@artq/shared` (`taxonomy-schemas.ts`). These tables have no `version`: last write wins, every change audited.

### 4.5 Inventory [inventory:read / inventory:adjust]
| Method | Path | Notes |
|--------|------|-------|
| GET | `/admin/inventory?q=&stock=low|out|oversold|uncounted&page=&limit=` | `{variantId, sku, label, product:{id,name,status}, onHand, reserved, available, lowStockThreshold, countedAt, isActive}`; `q` matches SKU or product name; oversold rows first. `low` = 0 < available ≤ threshold, `out` = available ≤ 0, `uncounted` = `countedAt` null |
| POST | `/admin/inventory/adjustments` [inventory:adjust] | `{rows:[{variantId, kind:'RECOUNT'|'ADJUSTMENT'|'DAMAGE_WRITE_OFF', quantity, note?}]}` (1–200 rows, one per variant; `adjustmentsBody` in `@artq/shared`, also used by the form). RECOUNT: count ≥ 0, sets `on_hand`, marks counted. ADJUSTMENT: ±delta ≠ 0. DAMAGE_WRITE_OFF: units > 0, removed. A note is required except for RECOUNT; \|quantity\| ≤ 100 000. **Schema contains no price/MRP/status/reserved fields** (unknown keys → 400). Unknown variant → 404; a result below 0 → 422 `INVALID_ADJUSTMENT` `{variantId}` and nothing is written. Response `{data:[rows after], oversold:[variantIds]}`: a count below `reserved` raises the `OVERSOLD` exception. Audited `inventory.adjust` with before/after |
| GET | `/admin/inventory/:variantId/movements?page=` | Ledger, newest first: `{reason, onHandDelta, reservedDelta, onHandAfter, reservedAfter, orderNumber, importId, note, actor, createdAt}` incl. reservations |
| GET | `/admin/inventory/count-sheet.xlsx` | Count sheet with every variant (SKU, Product, Variant, On hand (system), Counted quantity, Change (+/−), Note) plus a "How to use" sheet; the file an `INVENTORY` import expects |
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
| GET | `/admin/orders/:id/refundable` | refunds:create | Per item `{quantity, netAmount, reservedQty, reservedAmount, refundedQty, refundedAmount, availableQty, availableAmount}`; order `{shipping:{fee, reserved, available}, codFee:{…}, total:{cap, reserved, refunded, available}}`; payment `{amount, reserved, refunded, providerRefunded, available, reconciliationRequired}`. "Reserved" includes `REQUESTED`/`PENDING`/`UNKNOWN`/`PROCESSED` refunds |
| POST | `/admin/orders/:id/refunds` | refunds:create + step-up | Idempotency-Key (target `order:<number>`); `{kind, items:[{orderItemId, quantity, amount}], shippingAmount, codFeeAmount, reason, returnRequestId?}` → `201 {refundId, status:'REQUESTED', attempt:{no:1, receipt}}` (COD: `MANUAL_BANK`, no attempt); 409 `REFUND_EXCEEDS_CAPACITY` with `details.scope` |
| POST | `/admin/refunds/:id/manual-processed` | refunds:create + step-up | COD only: `{manualReference}` → `PROCESSED` |
| GET | `/admin/refunds?status=` | refunds:create | Queue incl. `UNKNOWN`/`FAILED`, attempts with key, receipt, last HTTP status |
| POST | `/admin/refunds/:id/retry` | refunds:create + step-up | Only `FAILED`. Reacquires capacity, then creates attempt n+1 with a **new** `X-Refund-Idempotency` key and receipt → `202 {attempt:{no, receipt}}`; 409 `REFUND_EXCEEDS_CAPACITY` if a newer refund used the capacity (refund stays `FAILED`); 409 `REFUND_RECONCILIATION_REQUIRED` while provider refunds are unexplained; 409 `REFUND_NOT_RETRYABLE` otherwise. `UNKNOWN` refunds are not retried by staff: the reconciler resends the same attempt |
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
| Coupons | `GET /admin/coupons?q=&state=active\|scheduled\|expired\|inactive&page=&limit=` · `POST` · `GET`/`PUT`/`DELETE /admin/coupons/:id` (shared `couponBody`: code 3–30 `[A-Za-z0-9_-]` stored in capitals, unique even against deleted coupons → field error on `code`; PERCENT 1–100 (+ optional `maxDiscount` ≥ ₹1), FLAT ≥ ₹1, FREE_SHIPPING 0; `minOrderValue`; `startsAt` < `endsAt`; `usageLimitTotal` (not below uses already taken), `usageLimitPerCustomer` (default 1, null = unlimited); `firstOrderOnly`, `isPublic`, `isActive`; `appliesTo` + existing `targetIds`). Editing `value`/`type` of a coupon with redemptions → 409 `COUPON_IN_USE` (create a new coupon). `DELETE` is a soft delete (stops working at once). `GET /admin/coupons/:id/redemptions` (status, over-limit, order number, customer). All audited | coupons:write |
| Shipping Rates | `GET /admin/shipping` → `{zones[{id,name,extraPerKg,isActive,sortOrder,slabs[{maxWeightG,rate}],states[],usedByOrders}], states[{id,name,zoneId}], settings}` · `POST /admin/shipping/zones`, `PUT`/`DELETE /admin/shipping/zones/:id` (shared `zoneBody`: slabs lightest first, a heavier slab never cheaper, ≤ 20; delete only an unused zone without states, else 409 `ZONE_IN_USE` `details.reason` `STATES`/`ORDERS`) · `PUT /admin/shipping/state-zones` `{assignments[{stateId, zoneId\|null}]}` · `PUT /admin/shipping/settings` (the `SHIPPING` setting; drops the public settings cache) · `GET /admin/shipping/pincodes?q=&filter=blocked\|no_cod\|custom_days`, `PUT`/`DELETE /admin/shipping/pincodes/:pincode` (`pincodeRuleBody`: COD needs delivery; both delivery days or neither) · `POST /admin/shipping/pincodes/import` `{csv, dryRun}` (columns `pincode,deliverable,cod,edd_min_days,edd_max_days,note`; ≤ 20,000 rows, 2 MB; every row checked, all saved or none → `{rows, created, updated, unchanged, errors[{line,message}], saved}`) · `POST /admin/shipping/preview` (one shipment through `shippingCharge`; read-only) | shipping:write |
| Shipping Rates | `GET/PUT /admin/shipping/zones` (zones, `extraPerKg`, slabs, state mapping); `PUT /admin/settings/SHIPPING`; CRUD `/admin/shipping/serviceability` (pincode rules, CSV import); `POST /admin/shipping/preview {pincode, lines}` → shipping breakdown | shipping:write |
| Restock Requests | `GET /admin/restock-requests?groupBy=variant&status=` → `{variant, product, pending, oldestAt, available}`; `POST /admin/restock-requests/notify {variantId}` (only when available > 0; idempotent per variant/day); `DELETE /admin/restock-requests/:id` | restock:read / restock:notify |

### 4.9 Imports, media, content
| Resource | Endpoints | Permission |
|----------|-----------|------------|
| Imports | `POST /admin/imports {kind:'CATALOG'|'INVENTORY', fileMediaId, createMissing?, fileName?}` (`createMissing` is catalogue only; each kind needs its own permission and a caller sees only the kinds they may import; inventory rows read back as `{kind, quantity, note, systemOnHand}`) → validation job (waits for the file's media check); `GET /admin/imports/:id` (status, counts); `GET /admin/imports/:id/rows?status=` (row outcomes, messages); `POST /admin/imports/:id/confirm`; `POST /admin/imports/:id/cancel`; `POST /admin/imports/:id/rows/:rowId/resolve {action:'apply'|'skip'}` for `NEEDS_REVIEW`; `GET /admin/imports/:id/result.xlsx`; `GET /admin/imports/template.xlsx?kind=`; `GET /admin/exports/catalog.xlsx` | imports:catalog (+ pricing:write if price columns change) / inventory:adjust |
| Media | `POST /admin/media/presign`, `POST /admin/media/:id/complete`, `POST /admin/media/:id/retry` (FAILED only), `GET /admin/media?kind=&status=&unused=1`, `DELETE /admin/media/:id` (409 if referenced) | media:write |
| CMS | CRUD `/admin/home-slides`, `/admin/reels`, `/admin/testimonials`, `/admin/faqs`, `/admin/pages`; `PUT /admin/settings/{ANNOUNCEMENT_BAR|HOME_SECTIONS|HERO|INSTAGRAM_MOMENTS|SOCIAL}`; `GET/PATCH /admin/messages`; `GET /admin/newsletter` + CSV export (step-up) | content:write |

### 4.10 Operations: exceptions, jobs, staff, settings, audit
| Resource | Endpoints | Permission |
|----------|-----------|------------|
| Payment exceptions | `GET /admin/payment-exceptions?status=&type=`; `GET /:id`; `POST /:id/resolve {resolution, note}`; `POST /:id/dismiss {note}`; `POST /admin/payments/reconcile {orderId? | from,to}` (manual run) | payments:exceptions |
| Jobs & webhooks | `GET /admin/ops/summary` (queue depths, failed counts, inbox status counts, outbox backlog, last scheduler runs); `GET /admin/ops/webhooks?status=`; `POST /admin/ops/webhooks/:id/retry` (DEAD/FAILED → RECEIVED); `GET /admin/ops/outbox-deliveries?status=&consumer=` (PENDING/LEASED/PUBLISHED-not-completed/DEAD with generation, last error); `POST /admin/ops/outbox-deliveries/:id/retry` (DEAD → PENDING, generation reset); `GET /admin/ops/jobs/failed`; `POST /admin/ops/jobs/:id/retry` | jobs:read / jobs:retry |
| Staff & permissions | `GET /admin/staff?q=&role=&status=&page=` (no step-up) → `{id, name, email, role, status, passwordSet, lastLoginAt, activeSessions}`; `POST /admin/staff {email, name, role}` → 201, new account or promoted customer, invite email (72 h single-use link), 409 `STAFF_EXISTS`/`ACCOUNT_BLOCKED`; `PATCH /admin/staff/:id {name?, role?}` (role change ends their admin sessions; `role:'CUSTOMER'` removes access → 204); `POST /admin/staff/:id/block` · `/unblock` · `/revoke-sessions` · `/send-password-link` (429 after 5 links/hour). Guards: own access → 422 `CANNOT_CHANGE_SELF`; demoting/blocking the last active SUPER_ADMIN → 409 `LAST_SUPER_ADMIN` (rows locked, safe under concurrency). Deferred with MFA: `POST /admin/staff/:id/reset-mfa` | staff:manage (+ step-up for changes) |
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
| `/auth/signup`, `/auth/password/forgot` | Share the 20/hour/IP email-sending budget with `/auth/otp/request` (each sends an email) |
| `/auth/signup/verify`, `/auth/otp/verify`, `/auth/password/reset`, `/auth/set-password` | 30/min/IP (in addition to per-code attempt caps) |
| OTP verify | 5 attempts per code |
| `/auth/refresh` | 30/min/session (session found from the cookie's hash; unknown cookies count against the IP) |
| `/checkout/*`, `/orders/:n/payment/retry` | 20/min/cart |
| `/contact`, `/custom-work`, `/newsletter/subscribe`, `/uploads/presign` | 5/min/IP |
| `/search/suggest` | 60/min/IP |
| `POST /cart/coupon` | 10/min/IP (codes cannot be guessed) |
| Default | 300/min/IP; admin 600/min/user |

Fixed windows counted in Redis (`rl:<bucket>:<key>`); IPv6 clients are keyed by /64. 429 `RATE_LIMITED` carries `Retry-After` and `details.retryAfterSeconds`; every limited response has `RateLimit-Limit/-Remaining/-Reset`. If Redis is unavailable requests are allowed (logged): the account lockout and OTP caps in PostgreSQL still apply.
