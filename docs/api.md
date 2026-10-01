# ArtQ: REST API Specification

> Base URL: `https://api.artq.in/v1` (local `http://localhost:4000/v1`) · JSON only · UTF-8
> Implemented in `apps/api` (Node.js + Express). Next.js and the admin SPA are **clients only**.
> Request/response schemas live as Zod schemas in `packages/shared` and are shared by all apps.

---

## 1. Conventions

| Topic | Rule |
|-------|------|
| Auth | `Authorization: Bearer <accessToken>`; refresh via httpOnly cookie `aq_rt` on `POST /auth/refresh` |
| Cart identity | `aq_cart` httpOnly cookie (set by API on first cart call). Logged-in users: cart resolved by user, guest cart merged on login |
| CORS | `credentials: true`; origins from `CORS_ORIGINS` |
| Money | Integers in **paise** in every request & response (`price: 84900`). Clients format with `formatINR()` |
| Dates | ISO-8601 UTC strings |
| IDs in URLs | Storefront uses slugs / order numbers; admin uses numeric ids |
| Pagination | `?page=1&limit=24` → `{ data: [...], meta: { page, limit, total, totalPages } }` (max limit 100) |
| Sorting | `?sort=price_asc` (whitelisted values per endpoint) |
| Errors | `{ "error": { "code": "STRING_CODE", "message": "Human text", "details": {...} } }` |
| Idempotency | `POST /checkout/initiate` accepts `Idempotency-Key` header (UUID) to prevent double orders on double-click |
| Rate limits | Headers `RateLimit-Limit`, `RateLimit-Remaining`, `Retry-After` on 429 |
| Versioning | `/v1` prefix; breaking changes → `/v2` |
| Caching | Public catalogue GETs send `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` |

### Common error codes
`VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `TOKEN_EXPIRED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`CONFLICT` (409), `OUT_OF_STOCK` (409), `PRICE_CHANGED` (409), `COUPON_INVALID` (422), `COUPON_MIN_ORDER` (422),
`COUPON_EXPIRED` (422), `COUPON_USAGE_EXCEEDED` (422), `COD_NOT_AVAILABLE` (422), `PINCODE_NOT_SERVICEABLE` (422),
`OTP_INVALID` (422), `OTP_EXPIRED` (422), `ACCOUNT_LOCKED` (423), `RATE_LIMITED` (429), `PAYMENT_VERIFICATION_FAILED` (422), `INTERNAL` (500).

---

## 2. Shared response shapes

```ts
type Money = number; // paise

type MediaRef = { id: number; url: string; width?: number; height?: number; alt?: string; placeholder?: string;
                  srcset?: { webp: string; avif?: string } };

type ProductCard = {
  id: number; slug: string; name: string;
  image: MediaRef | null; hoverImage: MediaRef | null;
  minPrice: Money; maxPrice: Money; mrp: Money | null;          // mrp of the min-price variant
  discountPercent: number | null;
  inStock: boolean; isNew: boolean; isTrending: boolean;
  variantCount: number;
  defaultVariantId: number | null;                              // set when variantCount === 1 (direct ADD)
  type: { slug: string; name: string };
};

type Variant = {
  id: number; sku: string; label: string;
  size: string | null; color: string | null; colorHex: string | null; thickness: string | null;
  price: Money; mrp: Money | null; discountPercent: number | null;
  stock: number;                 // capped at 50 for public responses
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
  image: MediaRef | null;
};

type ProductDetail = ProductCard & {
  description: string | null; shortDescription: string | null;
  productDetails: string[]; specificationsCare: string[]; howToUse: string | null;
  specifications: Record<string, string>;
  images: MediaRef[]; video: MediaRef | null;
  options: { size: string[]; color: { name: string; hex: string | null }[]; thickness: string[] };
  variants: Variant[];
  category: { slug: string; name: string } | null;
  techniques: { slug: string; name: string }[];
  sizeChart: { html?: string; content?: unknown } | null;
  breadcrumbs: { name: string; href: string }[];
  seo: { title: string; description: string; keywords?: string; ogImage?: string; canonical: string };
  rating: { avg: number; count: number } | null;
};

type CartView = {
  token: string;
  items: { id: number; variantId: number; productSlug: string; productName: string; variantLabel: string;
           image: MediaRef | null; unitPrice: Money; unitMrp: Money | null; quantity: number; lineTotal: Money;
           maxQuantity: number; available: boolean; priceChanged: boolean; warning?: string }[];
  coupon: { code: string; title: string; discount: Money } | null;
  totals: { itemCount: number; subtotal: Money; mrpTotal: Money; mrpDiscount: Money; couponDiscount: Money;
            shipping: Money | null; shippingEstimated: boolean; codFee: Money; total: Money; savings: Money;
            freeShippingThreshold: Money; freeShippingRemaining: Money; weightG: number };
  warnings: string[];
};
```

---

## 3. Public / storefront endpoints

### 3.1 Meta & content
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/settings/public` | n/a | Announcement bar, hero, home sections, shipping (threshold), payment flags (codEnabled…), social, store contact |
| GET | `/navigation` | n/a | Types with categories for header mega-menu & footer: `[{name, slug, image, categories:[{name, slug}]}]` |
| GET | `/home` | n/a | One call for the home page: `{ hero, types[], newArrivals: ProductCard[8], reels[], techniques[], testimonials[], instagram[] }` |
| GET | `/reels?limit=8` | n/a | `[{id, title, video: MediaRef, thumbnail, product: {slug, name, minPrice, image} | null}]` |
| POST | `/reels/:id/view` | n/a | Increment view count (rate-limited per IP) |
| GET | `/testimonials` | n/a | Active testimonials |
| GET | `/faqs` | n/a | Grouped `{ORDERS:[{q,a}],...}` |
| GET | `/pages/:slug` | n/a | CMS page `{title, content, seo}` |
| GET | `/states?country=IN` | n/a | `[{id, name, code}]` |
| GET | `/pincodes/:pincode` | n/a | `{pincode, city, district, state:{id,name}, serviceable, codAvailable, estimatedDays:{min,max}, shippingZone}`; 404 if unknown |
| GET | `/seo/sitemap-entries` | n/a | `[{loc, lastmod, changefreq, priority}]` for products, types, categories, techniques, collections, pages |
| GET | `/seo/resolve?path=/old-url` | n/a | Redirect lookup `{to, statusCode}` or 404 (used by Next.js middleware) |
| POST | `/newsletter/subscribe` | n/a | `{email, source}` → `201 {status:'SUBSCRIBED'}` / `200 {status:'ALREADY_SUBSCRIBED'}` |
| GET | `/newsletter/unsubscribe?token=` | n/a | Unsubscribes, returns `{ok:true}` |
| POST | `/contact` | n/a | `{name, email, phone?, subject, message, orderNumber?}` |
| POST | `/custom-work` | n/a | `{name, email, phone, details:{size, wood, quantity, budget, neededBy}, message, attachmentMediaIds[]}` |
| POST | `/uploads/presign` | optional | Customer uploads (return photos, custom-work refs): images only, ≤ 8 MB, max 4 |

### 3.2 Catalogue
| Method | Path | Description |
|--------|------|-------------|
| GET | `/types` | Active types `[{id, name, slug, image, productCount}]` |
| GET | `/types/:slug` | `{type, categories[], seo}` |
| GET | `/categories/:slug` | `{category, type, seo}` |
| GET | `/techniques` · `/techniques/:slug` | n/a |
| GET | `/collections/:slug` | n/a |
| GET | `/products` | Listing (below) |
| GET | `/products/:slug` | `ProductDetail`; 301 hint `{redirectTo}` if old slug |
| GET | `/products/:slug/availability` | **No-cache** live `{variants:[{id, price, mrp, stock, stockStatus}]}`, used by PDP after hydration |
| GET | `/products/:slug/related` | `{frequentlyBoughtTogether: ProductCard[], similar: ProductCard[]}` |
| GET | `/products/by-ids?ids=1,2,3` | Cards for recently-viewed / guest wishlist |
| GET | `/search?q=&…` | Same as `/products` with `q`; logs query |
| GET | `/search/suggest?q=res` | `[{type:'product', slug, name, image, minPrice} | {type:'category', slug, name}]` max 8 |

**`GET /products` query parameters**

| Param | Type | Example | Notes |
|-------|------|---------|-------|
| `type` | slug (multi, comma) | `pigments` | |
| `category` | slug (multi) | `gel-pigments,powder-pigments` | |
| `technique` | slug (multi) | `deep-pour-casting` | |
| `collection` | slug | `beginner-kit` | |
| `q` | string | `gold` | Full-text |
| `minPrice` / `maxPrice` | paise | `5000` | Applies to variant price |
| `size` | string (multi) | `20 gm` | |
| `color` | string (multi) | `Metallic Gold` | |
| `inStock` | `1` | | |
| `sale` | `1` | | MRP > price |
| `isNew` / `isTrending` | `1` | | |
| `sort` | enum | `featured` · `newest` · `price_asc` · `price_desc` · `name_asc` · `best_selling` · `relevance` (default when q) | |
| `page` / `limit` | int | `1` / `24` | |

Response:
```json
{
  "data": [ /* ProductCard[] */ ],
  "meta": { "page": 1, "limit": 24, "total": 48, "totalPages": 2 },
  "facets": {
    "types":      [{ "slug": "pigments", "name": "Pigments", "count": 44 }],
    "categories": [{ "slug": "gel-pigments", "name": "Gel Pigments", "count": 29 }],
    "techniques": [{ "slug": "resin-art", "name": "Resin Art", "count": 40 }],
    "sizes":      [{ "value": "20 gm", "count": 29 }, { "value": "10 gm", "count": 12 }],
    "colors":     [{ "value": "Metallic Gold", "hex": "#d4af37", "count": 1 }],
    "price":      { "min": 6000, "max": 83000 }
  }
}
```

### 3.3 Auth
| Method | Path | Body | Response / notes |
|--------|------|------|------------------|
| POST | `/auth/signup` | `{name, email, phone, password, marketingOptIn}` | `201 {userId, otpSentTo:'e***@gmail.com'}`; user `PENDING_VERIFICATION`; OTP emailed |
| POST | `/auth/signup/verify` | `{email, code}` | `{accessToken, user}` + sets `aq_rt`; merges guest cart & wishlist |
| POST | `/auth/login` | `{identifier (email\|phone), password}` | `{accessToken, user}` + cookie. Errors: `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `NOT_VERIFIED` |
| POST | `/auth/otp/request` | `{identifier, purpose: 'LOGIN'\|'GUEST_ORDER_ACCESS'}` | `{sent:true, resendAfter:30}` (always 200 to avoid enumeration) |
| POST | `/auth/otp/verify` | `{identifier, purpose, code}` | `{accessToken, user}` + cookie (creates guest user if needed for GUEST_ORDER_ACCESS) |
| POST | `/auth/refresh` | cookie | `{accessToken, user}`; rotates cookie. 401 if invalid/reused |
| POST | `/auth/logout` | cookie | Revokes session; clears cookie |
| POST | `/auth/logout-all` | auth | Revokes all sessions |
| POST | `/auth/password/forgot` | `{email}` | Always `{ok:true}` |
| POST | `/auth/password/reset` | `{token, password}` | `{ok:true}`; revokes all sessions |
| POST | `/auth/password/change` | auth `{currentPassword, newPassword}` | n/a |
| POST | `/auth/set-password` | auth (guest/OTP user) `{password}` | Converts guest to full account |

`user` object: `{id, name, email, phone, role, emailVerified, phoneVerified, isGuest, marketingOptIn}`.

### 3.4 Account (auth required)
| Method | Path | Description |
|--------|------|-------------|
| GET / PATCH | `/me` | Profile; PATCH `{name, phone, marketingOptIn}` |
| POST | `/me/email/change` | `{newEmail}` → OTP to new email; `POST /me/email/verify {code}` |
| DELETE | `/me` | `{password or otp}` → soft delete |
| GET | `/me/addresses` | List |
| POST | `/me/addresses` | `{label, fullName, phone, line1, line2?, landmark?, city, stateId, pincode, isDefault}` |
| PATCH / DELETE | `/me/addresses/:id` | n/a |
| POST | `/me/addresses/:id/default` | n/a |
| GET | `/me/wishlist` | `ProductCard[]` |
| POST | `/me/wishlist/toggle` | `{productId}` → `{inWishlist: boolean, count}` |
| POST | `/me/wishlist/merge` | `{productIds[]}` from localStorage after login |
| GET | `/me/orders?status=&page=` | `[{orderNumber, createdAt, status, paymentStatus, total, itemCount, thumbnails[]}]` |
| GET | `/me/orders/:orderNumber` | Full order (items, totals, address, payment, shipments, history, actions:{canCancel, canReturn, canRetryPayment}) |
| POST | `/me/orders/:orderNumber/cancel` | `{reason}` |
| POST | `/me/orders/:orderNumber/return` | `{reason, description, items:[{orderItemId, quantity}], mediaIds[]}` |
| POST | `/me/orders/:orderNumber/reorder` | Adds available items to cart → `CartView` |
| GET | `/me/orders/:orderNumber/invoice.pdf` | PDF stream |
| GET | `/me/notifications` | (Phase 9) |

### 3.5 Public order tracking (guests)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/orders/track/:orderNumber?token=` | Token from email link → limited order view + timeline |
| POST | `/orders/track` | `{orderNumber, emailOrPhone}` → sends OTP → then `/auth/otp/verify` (purpose GUEST_ORDER_ACCESS) |

### 3.6 Cart (guest or user; `aq_cart` cookie)
| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/cart` | n/a | `CartView` (re-priced live, stock-clamped) |
| POST | `/cart/items` | `{variantId, quantity}` | Adds/increments; 409 `OUT_OF_STOCK` with `available` |
| PATCH | `/cart/items/:itemId` | `{quantity}` | 0 = remove |
| DELETE | `/cart/items/:itemId` | n/a | n/a |
| DELETE | `/cart` | n/a | Clear |
| POST | `/cart/coupon` | `{code}` | Applies; 422 with specific coupon error codes |
| DELETE | `/cart/coupon` | n/a | n/a |
| GET | `/cart/coupons` | n/a | Public coupons with eligibility `[{code, title, description, eligible, reason?}]` |
| POST | `/cart/estimate` | `{pincode, paymentMethod?}` | Saves pincode; returns `CartView` with real shipping |
| POST | `/cart/contact` | `{email, phone}` | Captured at checkout step 1 (abandoned-cart reminders) |
| POST | `/cart/merge` | auth | Merges cookie cart into user cart (also done automatically at login) |

### 3.7 Checkout & payments
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/checkout/quote` | optional | `{addressId? | address, paymentMethod}` → final `CartView` incl. shipping, COD fee, `codAvailable`, `codReason?` |
| POST | `/checkout/initiate` | optional | Creates order; see below |
| POST | `/checkout/verify` | optional | `{orderNumber, razorpayOrderId, razorpayPaymentId, razorpaySignature}` → `{orderNumber, status:'PLACED'}` |
| POST | `/checkout/payment-failed` | optional | `{orderNumber, razorpayOrderId, error:{code, description}}` logs failed attempt |
| POST | `/orders/:orderNumber/retry-payment` | token or auth | New Razorpay order for an unexpired PENDING order |
| POST | `/webhooks/razorpay` | signature | Raw body; events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed` |

**`POST /checkout/initiate`**
```json
// request (Idempotency-Key: 6f1c…)
{
  "contact": { "email": "hema@example.com", "phone": "+919876543210", "createAccount": false },
  "shippingAddressId": null,
  "shippingAddress": { "fullName": "Hema R", "phone": "+919876543210", "line1": "12, Rose Villa",
                       "line2": "MG Road", "landmark": "Near SBI", "city": "Kochi", "stateId": 18, "pincode": "682016",
                       "label": "HOME", "save": true },
  "billingSameAsShipping": true,
  "billingAddress": null,
  "gstin": null, "businessName": null,
  "paymentMethod": "RAZORPAY",
  "customerNote": "Gift wrap please",
  "expectedTotal": 134900,
  "utm": { "source": "instagram", "medium": "social", "campaign": "diwali" }
}
```
```json
// 201 response (RAZORPAY)
{
  "orderNumber": "AQ10234",
  "status": "PENDING_PAYMENT",
  "total": 134900,
  "razorpay": { "keyId": "rzp_live_xxx", "orderId": "order_NabcXYZ", "amount": 134900, "currency": "INR",
                "name": "ArtQ", "prefill": { "name": "Hema R", "email": "hema@example.com", "contact": "+919876543210" } },
  "expiresAt": "2026-10-01T10:30:00Z"
}
// 201 response (COD): { "orderNumber": "AQ10235", "status": "PLACED", "total": 138900 }
// 409 PRICE_CHANGED if server total ≠ expectedTotal → client shows updated cart
```

---

## 4. Admin endpoints (`/admin/*`, role ≥ STAFF; permissions noted)

### 4.1 Dashboard & search
| Method | Path | Perm | Description |
|--------|------|------|-------------|
| GET | `/admin/dashboard?range=7d` | `dashboard:read` | `{revenue, orders, aov, newCustomers, salesSeries[], ordersByStatus{}, topProducts[], lowStock[], pendingActions{toConfirm, toShip, returns, messages}}` |
| GET | `/admin/search?q=` | any staff | Orders, products, customers quick search |
| GET | `/admin/notifications` · POST `/admin/notifications/read` | any | n/a |

### 4.2 Catalogue
| Method | Path | Perm | Notes |
|--------|------|------|-------|
| GET | `/admin/products?q=&type=&category=&status=&stock=low\|out&flag=new\|trending&page=` | `products:read` | Table rows with price range & total stock |
| POST | `/admin/products` | `products:write` | Full product + variants + images payload |
| GET | `/admin/products/:id` | `products:read` | n/a |
| PUT | `/admin/products/:id` | `products:write` | Replace (variants upserted by id; missing → soft-deleted if no orders else deactivated) |
| PATCH | `/admin/products/:id` | `products:write` | Partial (`isActive`, `isNewArrival`, `isTrending`, ranks) |
| DELETE | `/admin/products/:id` | `products:write` | Soft delete |
| POST | `/admin/products/:id/duplicate` | `products:write` | n/a |
| POST | `/admin/products/bulk` | `products:write` | `{ids[], action:'activate'\|'deactivate'\|'markNew'\|'unmarkNew'\|'markTrending'\|'unmarkTrending'\|'delete'}` |
| PATCH | `/admin/variants/:id` | `inventory:write` | `{price, mrp, stock, lowStockThreshold, isActive, weightG}`; stock change requires `{stockReason, note}` |
| POST | `/admin/inventory/adjust` | `inventory:write` | `[{variantId, delta|set, reason, note}]` |
| GET | `/admin/inventory?lowStock=1` · `/admin/inventory/:variantId/movements` | `inventory:read` | n/a |
| CRUD | `/admin/types`, `/admin/categories`, `/admin/techniques`, `/admin/collections`, `/admin/size-charts` | `catalog:write` | Includes `PATCH /admin/types/reorder {ids[]}` |
| POST | `/admin/imports` | `products:write` | multipart `.xlsx` + `mode` → `{importId, status:'VALIDATED', totalRows, validRows, errors[], preview:[{product, variants[], action:'create'|'update'}]}` |
| POST | `/admin/imports/:id/confirm` | `products:write` | Enqueues job → `{status:'IMPORTING'}` |
| GET | `/admin/imports/:id` | `products:read` | Progress & report |
| GET | `/admin/exports/products.xlsx` · `/admin/imports/template.xlsx` | `products:read` | n/a |

### 4.3 Media
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/media/presign` | `{filename, contentType, size}` → `{uploadUrl, key, headers}` |
| POST | `/admin/media/complete` | `{key, kind}` → `{media}` (status PROCESSING → READY via job) |
| GET | `/admin/media?kind=&page=` · DELETE `/admin/media/:id` | Library |

### 4.4 Orders, returns, customers
| Method | Path | Perm | Notes |
|--------|------|------|-------|
| GET | `/admin/orders?status=&paymentStatus=&method=&from=&to=&q=&page=` | `orders:read` | n/a |
| GET | `/admin/orders/:id` | `orders:read` | Full detail incl. payments, refunds, history, emails sent |
| POST | `/admin/orders/:id/status` | `orders:write` | `{to, note, notifyCustomer, shipment?: {courierName, awbNumber, trackingUrl}}`; validates transition |
| PATCH | `/admin/orders/:id` | `orders:write` | Edit shipping address (before PACKED), admin note |
| POST | `/admin/orders/:id/cancel` | `orders:write` | `{reason, refund: boolean, restock: boolean}` |
| POST | `/admin/orders/:id/refund` | `refunds:write` | `{amount, reason, items?[]}` → Razorpay refund |
| GET | `/admin/orders/:id/invoice.pdf` · `/packing-slip.pdf` | `orders:read` | n/a |
| POST | `/admin/orders/:id/resend-email` | `orders:write` | `{template}` |
| GET | `/admin/orders/export.csv?…` | `orders:read` | n/a |
| GET / PATCH | `/admin/returns`, `/admin/returns/:id` | `orders:write` | Approve/reject `{status, refundAmount, restock, adminNote}` |
| GET | `/admin/customers?q=&page=` · `/admin/customers/:id` | `customers:read` | n/a |
| PATCH | `/admin/customers/:id` | `customers:write` | `{status:'BLOCKED'|'ACTIVE', adminNotes}` |

### 4.5 Marketing & content
| Resource | Endpoints |
|----------|-----------|
| Coupons | CRUD `/admin/coupons`, GET `/admin/coupons/:id/redemptions` |
| Shipping | GET/PUT `/admin/shipping/zones` (zones + slabs + state mapping), PUT `/admin/settings/SHIPPING` |
| Reels | CRUD `/admin/reels`, PATCH `/admin/reels/reorder` |
| Testimonials | CRUD `/admin/testimonials` |
| Home slides | CRUD `/admin/home-slides` |
| FAQs / CMS pages | CRUD `/admin/faqs`, `/admin/pages` |
| Newsletter | GET `/admin/newsletter?status=`, GET `/admin/newsletter/export.csv` |
| Restock requests | GET `/admin/stock-notifications?groupBy=variant`, POST `/admin/stock-notifications/notify {variantId}` |
| Abandoned carts | GET `/admin/carts/abandoned`, POST `/admin/carts/:id/remind` |
| Search terms | GET `/admin/reports/search-terms?range=30d` |
| Messages | GET/PATCH `/admin/messages` |
| SEO | CRUD `/admin/seo/overrides`, `/admin/seo/redirects` |
| Settings | GET `/admin/settings`, PUT `/admin/settings/:key` (SUPER_ADMIN for PAYMENT/STORE_INFO) |
| Staff | CRUD `/admin/staff` (SUPER_ADMIN), POST `/admin/me/2fa/setup`, `/admin/me/2fa/verify` |
| Audit | GET `/admin/audit-logs?entity=&actor=&page=` (SUPER_ADMIN) |
| Reports | GET `/admin/reports/sales?from&to&groupBy=day|month`, `/admin/reports/products`, `/admin/reports/gst?month=` (GSTR-1 friendly CSV) |

---

## 5. Webhooks (incoming)

### Razorpay `POST /v1/webhooks/razorpay`
1. Read **raw body**; verify `X-Razorpay-Signature` = HMAC-SHA256(rawBody, `RAZORPAY_WEBHOOK_SECRET`). Fail → 400.
2. Insert into `webhook_events` with `event_id` (header `x-razorpay-event-id`); on unique conflict → 200 (duplicate).
3. Handle:
   - `payment.captured` / `order.paid` → `markOrderPaid` (idempotent; amount check).
   - `payment.failed` → record attempt failure (order stays PENDING_PAYMENT).
   - `refund.processed` / `refund.failed` → update `refunds`, order `payment_status`.
4. Always respond 200 within 5 s (heavy work → queue).

### Shiprocket `POST /v1/webhooks/shiprocket` *(Phase 9)*
Token header check → map courier status → `shipments.status` → order status transition + customer email.

---

## 6. Rate limits

| Scope | Limit |
|-------|-------|
| `/auth/login`, `/auth/signup` | 10 / min / IP; 5 failed logins → 15 min account lock |
| `/auth/otp/request` | 5 / hour / target, 20 / hour / IP, 30 s cooldown |
| `/auth/otp/verify` | 5 attempts per OTP |
| `/checkout/*` | 20 / min / cart |
| `/contact`, `/custom-work`, `/newsletter/subscribe` | 5 / min / IP |
| `/search/suggest` | 60 / min / IP |
| Everything else | 300 / min / IP |
| `/admin/*` | 600 / min / user |

---

## 7. Example: the full happy path (curl)

```bash
# 1. browse
curl https://api.artq.in/v1/products?type=resins
curl https://api.artq.in/v1/products/2-1-epoxy-resin
# 2. add to cart (cookie jar keeps aq_cart)
curl -c j -b j -X POST https://api.artq.in/v1/cart/items -H 'content-type: application/json' -d '{"variantId":2,"quantity":1}'
# 3. estimate shipping
curl -c j -b j -X POST https://api.artq.in/v1/cart/estimate -d '{"pincode":"682016"}' -H 'content-type: application/json'
# 4. initiate checkout (guest) → razorpay order
curl -c j -b j -X POST https://api.artq.in/v1/checkout/initiate -H 'Idempotency-Key: 6f1c…' -H 'content-type: application/json' -d @checkout.json
# 5. Razorpay Checkout in browser → POST /checkout/verify with the 3 razorpay fields
```
