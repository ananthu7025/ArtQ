# ArtQ: Product Requirements Document (PRD)

> Version 2.0 (reliability & admin review, see [review.md](review.md)) · Owner: ArtQ / Eayila Consultancy
> Reference prototype: https://qcraft-nine.vercel.app/ · Mobile reference: `../ArtQ Site Ref.png`
> Single-vendor Indian D2C store. Rules in §8 are authoritative for behaviour; [architecture.md](architecture.md) and [database.md](database.md) implement them.

---

## 1. Vision & goals

**Vision:** the go-to online store in India for resin artists and hobbyists. They can buy everything for a resin project (resin, frames/moulds, pigments, glitters, tools) in one place, with fast delivery and trustworthy quality.

### 1.1 Business goals (first 6 months after launch)
| Goal | Metric | Target |
|------|--------|--------|
| Sell online directly | Orders / month | 300+ |
| Grow basket size | Average order value | ≥ ₹1,100 |
| Convert mobile visitors | Mobile conversion rate | ≥ 1.5 % |
| Reduce manual work | Orders processed without phone/WhatsApp back-and-forth | ≥ 90 % |
| Money correctness | Payments/refunds unresolved > 24 h | 0 |

### 1.2 Non-goals for v1
- Marketplace / multiple sellers; international shipping; native apps; multi-language; live chat (WhatsApp click-to-chat instead).
- **Backorders** (no selling beyond available stock).
- **Split shipments** (one shipment per order).
- **Phone/SMS/WhatsApp OTP and phone login** (email OTP only; SMS after DLT registration, post-launch).
- Product reviews, collections, abandoned-cart automation, advanced reports, loyalty (post-launch backlog, tasklist.md).

---

## 2. Users (personas)
| Persona | Description | Needs |
|---------|-------------|-------|
| **Hobbyist Hema** (primary) | Learns resin art from Instagram, buys small quantities | Clear sizes/prices, reels, free-shipping nudge, UPI/COD |
| **Pro Artist Pranav** | Workshops, buys 3–6 kg resin and many frames | Re-order, stock visibility, GST invoice |
| **Preservation Priya** | Wedding-garland/flower preservation | Teak/double frames, silica gel, custom work |
| **Gift Buyer Gautam** | One-time buyer | Guest checkout, tracking link |
| **Admin Anu** (owner) | Runs catalogue, stock, orders, refunds | Fast product entry, import, order queue, exception queue |
| **Staff Sanju** (packer) | Packs and ships | Order queue, packing slips, AWB entry, stock counts; **cannot change prices** |

---

## 3. Information architecture (site map)
```
/                               Home
/shop                           All products (filters, sort)
/type/:slug                     Products of a Type
/category/:slug                 Products of a Category
/technique/:slug                Products tagged with a technique
/new-arrivals  /trending        Flagged products
/product/:slug                  Product detail page (PDP)
/search?q=                      Search results
/cart                           Cart
/checkout                       Checkout
/checkout/success/:orderNumber  Confirmation (or "payment processing")
/wishlist
/login  /signup  /signup/verify  /forgot-password  /reset-password  /set-password
/account  /account/addresses
/orders  /orders/:orderNumber   Account orders
/track/:orderNumber             Guest tracking (token link) + "verify email to manage this order"
/about  /contact  /faqs  /custom-work
/terms  /privacy-policy  /shipping-policy  /return-policy  /cancellation-policy
/404
(post-launch) /collection/:slug
```
Slugs: lowercase, hyphenated, unique; renamed slugs 301-redirect. Filters live in the query string (`/shop?type=pigments&size=20+gm&sort=price_asc&page=2`).

---

## 4. Global elements

### 4.1 Announcement bar
Full-width strip, **dark** brand background (`brand-800`, white text 12–13 px, contrast ≥ 4.5:1). Marquee of admin-editable messages separated by "•". Default: `Shipping all over India • Free shipping on orders above ₹1000`. Pauses on hover/focus; static under `prefers-reduced-motion`.

### 4.2 Header
| Area | Mobile (< 768 px) | Desktop (≥ 1024 px) |
|------|-------------------|---------------------|
| Left | ☰, 🔍 | Logo |
| Centre | Logo | HOME · SHOP ▾ · SHOP ALL · NEW ARRIVALS · ABOUT US · CONTACT |
| Right | 👤, ♡ (count), 🛒 (count) | 🔍, LOGIN / SIGN UP or name, ♡, 🛒 |

Sticky; hides on scroll-down (mobile). SHOP ▾ mega-menu: types → categories. Mobile drawer (85 % width, focus-trapped). Count badges show 0 like the reference. Search overlay with debounced suggestions (≥ 2 chars, 250 ms).

### 4.3 Footer
Newsletter band → logo + tagline *"Handcrafted resin art and wooden frames, bringing natural beauty into your everyday spaces."* → columns **TYPE** (active types), **CONNECT** (About Our Craft, Contact Us, FAQs, Instagram, WhatsApp), **POLICIES** (Terms, Privacy, Shipping, Return & Refund, Cancellation) → payment icons → `© {year} ART Q. ALL RIGHTS RESERVED.` · `powered by Eayila Consultancy`.

### 4.4 Floating elements
WhatsApp button (pre-filled product name on PDP), mini-cart drawer, toasts.

---

## 5. Storefront pages

### 5.1 Home `/`
Sections (admin can reorder/toggle):
1. **Hero**: muted looping video with poster; "ARTQ" / "WOOD MOULDS & RESINS"; optional CTA; poster only on `saveData`.
2. **"CHECK OUT OUR RANGE": Product Category**: circular tiles for active types in sort order (Resins, Wooden Frames, Multiwood Frames, Hoops, Silica Gel, Pigments, Glitters, UV Resin (link override → category), More.. → `/shop`).
3. **New Arrivals**: heading spelled correctly ("New Arrivals"; the reference shows "New Arivals"); "Explore our newly launched products"; up to 8 cards; "View all".
4. **Trending now**: 9:16 reels linked to products (autoplay when ≥ 50 % visible, one at a time on mobile); fallback trending grid.
5. **Shop by Technique** (optional).
6. **Stories with our product**: testimonial carousel (accessible controls, pause on hover/focus).
7. **Instagram moments** (optional).

Only `ACTIVE` products appear anywhere on the storefront.

### 5.2 Listing pages
Shared template for shop/type/category/technique/new-arrivals/trending/search: banner + breadcrumb, category chips, result count, sort (Featured, Newest, Price ↑/↓, Name, Best selling), filters (type, category, technique, price, size, colour, thickness, in stock, on sale), active-filter chips, 24 per page with "Load more" + `?page=`, skeletons, empty state.
**Filter rule:** variant filters (size, colour, thickness, price, in stock, on sale) must all be satisfied **by the same variant**. The card's "From ₹" shows the cheapest matching variant.

### 5.3 Product detail page `/product/:slug`
Gallery (swipe, thumbnails, zoom, lightbox, optional video) · name · price block (`₹849`, struck MRP, "15 % OFF", "Inclusive of all taxes") · variant selectors (Size → Colour → Thickness; only options with > 1 value; unavailable combinations marked; `?variant=<sku>`) · stock message (In stock / Only a few left / Out of stock, without exact counts) · quantity (max = min(available, 50)) · ADD TO CART / BUY NOW / ♡ · **Notify me** (email) when out of stock · pincode check (serviceability + COD + estimated days; *a known pincode is not necessarily deliverable*) · trust row · accordions (Description, Product details, Specifications & care, How to use, Shipping & returns) · technique chips · frequently bought together · similar · recently viewed · sticky mobile add-to-cart.
Price and stock are re-fetched live after load (cached HTML may be up to ~3 minutes old). JSON-LD Product + Breadcrumb.

### 5.4 Search
Name, type, category, SKU, variant options, tags, description; typo-tolerant suggestions; zero-results state; queries logged.

### 5.5 Cart `/cart`
Line items (image, name, variant, price, qty, total, remove + undo, move to wishlist) · stock/price-change warnings · free-shipping progress ("Add ₹151 more for FREE shipping") · coupon box (validated now; **capacity is reserved only when you place the order**) · summary (subtotal, MRP savings, coupon, shipping estimate, total) · empty state. Guest carts persist 30 days and merge on login.

### 5.6 Checkout `/checkout`
**Step 1, Contact.** Logged in: account details. Guest: email + 10-digit mobile (unverified; used for this order's updates). "Email me a link to set a password" option. If the email may belong to an account: "Have an account? Log in" (never reveals whether it does).
**Step 2, Address.** Saved addresses or a new one. Pincode auto-fills city/state from the postal directory, then serviceability is checked separately ("Sorry, we don't deliver to 7xxxxx yet"). Billing same/different; optional GSTIN + business name.
**Step 3, Shipping & payment.** Shipping line with breakdown when a heavy surcharge applies ("Free shipping up to 10 kg + ₹120 for extra weight"). Payment: **Pay online (Razorpay)** or **Cash on Delivery** when enabled and allowed (amount within limits, pincode COD-enabled; reason shown otherwise; COD fee shown). Notes; terms checkbox; `PLACE ORDER · ₹1,349`.
**Payment behaviour (customer view):**
- Placing an order reserves stock for **30 minutes** while you pay.
- After paying, you see **"Order placed"**, or **"Payment processing: we're confirming with your bank"** (polls automatically, up to 2 minutes, then "we'll email you").
- Payment failed or closed: "Payment didn't go through" with **Retry payment** and **Switch to COD** (if allowed).
- If a payment arrives after the order expired and an item sold out, the customer is told it is being refunded in full (§8.6).

### 5.7 Mini-cart drawer
Opens on add-to-cart: added item, subtotal, free-shipping progress, VIEW CART / CHECKOUT.

### 5.8 Confirmation `/checkout/success/:orderNumber`
"Thank you, Hema! Order **AQ10234** placed." Items, total, payment method, address, estimated delivery; buttons: Track order, Continue shopping. Guests: "Set a password" (sends the link to the order email). Analytics `purchase` fires once, only for `PLACED`.

### 5.9 Auth pages (email only at launch)
| Page | Behaviour |
|------|-----------|
| `/login` | Email + password, or **email OTP** tab. 5 failures → 15-min lock |
| `/signup` | Name, email, optional phone (contact only), password (≥ 8, letter + number), consent → email OTP → account active; guest orders with that email are linked |
| `/forgot-password` → `/reset-password` | Neutral response; 30-min single-use link; logs out all sessions |
| `/set-password?token=` | From the post-checkout email: proves email ownership, creates the account, links guest orders |

### 5.10 Account & guest order access
- **Account:** profile (email change via OTP to the new email; phone is contact-only), password, addresses (max 10), orders, wishlist, delete account.
- **Order detail:** items, price breakup, address, payment, shipment tracking, invoice (after dispatch), **Cancel** (while placed/confirmed and not yet packed), **Report a problem** (within 48 h of delivery: damaged/wrong/defective/missing; photos), **Buy again**, timeline.
- **Guests:** the order email contains a tracking link (read-only). To cancel, report a problem, download the invoice or view uploaded photos, the guest verifies the order email with a one-time code; access lasts 1 hour for that order only.

### 5.11 Content pages
About, Contact (form → admin Messages), Custom work (form + private photo upload), FAQs, policy pages, 404.

---

## 6. Shared components
- **Product card**: cover image (placeholder if none), badges (NEW, −X %, Out of stock), ♡, name (2 lines), "From ₹190" / "₹250", struck MRP, ADD pill (single variant → add; multiple → quick-add sheet; out of stock → NOTIFY ME).
- **Section title**: centred serif heading with teal lines (design-system.md §5.1).
- **Price format**: `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'})`, no decimals for whole rupees.

---

## 7. Admin panel (`admin.artq.in`)

### 7.1 Access
Email + password, then **mandatory TOTP** for every staff role (recovery codes; SUPER_ADMIN reset). Sensitive actions ask for the code again (step-up). Roles and permissions: architecture.md §5.9. The UI hides what the user can't do; the API enforces it.

### 7.2 Navigation
Left sidebar, **independently scrollable** (`height: 100dvh; overflow-y: auto`, sticky). The lowest item must be reachable at 768 px height and at 200 % zoom. Below 1024 px it collapses into an off-canvas drawer opened from the top bar (focus-trapped, Esc closes). Selected item: high-contrast state (design-system.md §6.4). Order follows the provided admin screenshot, then the modules this plan already requires:

| Group | Module | MVP | Permission |
|-------|--------|:---:|-----------|
| *(screenshot)* | Dashboard | ✓ | dashboard:read |
| | Orders | ✓ | orders:read |
| | Customers | ✓ | customers:read |
| | Coupons | ✓ | coupons:write |
| | Shipping Rates | ✓ | shipping:write |
| | Products | ✓ | catalog:read |
| | Restock Requests | ✓ | restock:read |
| | Product Types | ✓ | catalog:write |
| | Categories | ✓ | catalog:write |
| | Techniques | ✓ | catalog:write |
| Operations | Inventory | ✓ | inventory:read |
| | Returns & Refunds | ✓ | returns:receive / refunds:create |
| | COD Remittances | ✓ | cod:remit |
| | Payment Exceptions | ✓ | payments:exceptions |
| | Jobs & Webhooks | ✓ | jobs:read |
| Catalogue tools | Imports | ✓ | imports:catalog / inventory:adjust |
| | Media | ✓ | media:write |
| Content | CMS (home, reels, testimonials, FAQs, pages, announcement) + Messages | ✓ | content:write |
| Admin | Staff & Permissions | ✓ | staff:manage |
| | Settings | ✓ | settings:write |
| | Audit Logs | ✓ | audit:read |
| Post-launch | Advanced reports, abandoned carts, newsletter campaigns, collections, reviews | Backlog | n/a |

All tables are **server-side paginated/filtered**, have loading (skeleton rows), empty ("No products match. Clear filters") and error ("Couldn't load. Retry") states, and show mutation feedback (button spinner, success toast, inline error, optimistic rollback). Every mutation is permission-checked server-side and audited.

### 7.3 Products page (screenshot module, extended)
**Preserved from the screenshot:**
- Search box (name / SKU).
- **Add Product** button → editor (new DRAFT).
- **Product-type tabs**: "All" + as many types (by sort order) as fit the width, at least 5 on desktop, + **More ▾** overflow menu for the rest + "Unassigned" (drafts without type). Each tab shows a count.
- Table columns: **# (serial number)**, **Image** (48 px thumbnail), **Name**, **Type**, **Status**, **Variants** (count), **Actions**.
- **Activation toggle** in Status = publish/unpublish. Turning it on runs the publication gate; if it fails, the toggle snaps back and a popover lists what's missing (link to fix). Requires `catalog:publish`; otherwise the toggle is shown read-only.
- **Edit** and **Delete** actions. Delete is offered only for never-ordered drafts; otherwise the menu shows **Archive**. Both need a confirmation dialog with the product name.
- **Previous / Next** pagination with "Page 3 of 7"; current page kept in the URL.

**Added commerce controls:**
- Columns: **Price range** (`₹90` or `₹190–₹890`), **Available stock** (Σ available; red when 0, amber when low), **Status** pill `Draft` / `Active` / `Archived`, readiness icon (✓ or ⚠ with failing checks on hover).
- Filters: status, stock (in/low/out/oversold), readiness (ready / blocked / specific check), image state, flags; sort by updated / name / price / stock.
- **Bulk actions** with select-all-on-page: Publish, Unpublish, Archive, Mark/Unmark New, Mark/Unmark Trending, Set type/category. Each action reports per-row success/failure.
- **Import / Export** buttons (→ Imports module; export current filter to xlsx).
- Row action **Variants** opens the variant drawer: inline edit of non-commercial fields; price/MRP cells editable only with `pricing:write` (otherwise read-only with a lock icon); stock shown as on hand / reserved / available with a link to Inventory.

**Requirements derived from issues visible in the screenshot (to verify against the build, not assumed code bugs):**
| Visible issue | Requirement |
|---------------|-------------|
| Every product's type shows "Unknown" | The list DTO includes `type {id, name}` resolved by relation (api.md §4.3). A product without a type shows a neutral **"Unassigned"** badge and can be filtered. "Unknown" must never be rendered. A contract test asserts every seeded product shows its real type name |
| Several images missing | Distinguish **Processing** (spinner thumbnail), **Failed** (red icon + "Retry processing"), **Missing** (grey placeholder + "Add image"), with a fixed-size fallback so rows don't jump. A missing/failed cover blocks publication |
| Sidebar cut off below "Techniques" | Independently scrollable sidebar and drawer behaviour (§7.2); E2E test: at 1280×720 and 1024×600 every nav item is reachable by scroll and keyboard |
| Teal controls / selected nav | Contrast ≥ 4.5:1 for text and ≥ 3:1 for UI component boundaries (design-system.md §2.3) |

### 7.4 Product editor
Sections: Basics (name, slug, type, category (filtered by type), techniques) · Descriptions (rich text, details list, specs & care, how to use, specifications) · Media (upload, reorder, cover, alt, per-image state) · **Variants grid** (size + net quantity/unit, colour + hex, thickness, SKU, weight + "measured/estimated", dims, shipping class, image, active; price/MRP/cost columns gated by `pricing:write`) · Tax (HSN, GST %, "Approve tax" by `catalog:publish`) · Relations · Flags & ranks · SEO with preview · **Readiness panel** (§8.7) · version conflict handling ("This product was changed by Anu at 10:42. Reload / compare").

### 7.5 Other modules (summary)
| Module | Key capabilities |
|--------|------------------|
| **Dashboard** | Today/7 d/30 d revenue, orders, AOV, new customers; sales chart; pending actions (to confirm/pack/ship, returns to decide, open exceptions, restock requests, messages); low stock; top products |
| **Orders** | Filters by order/payment/fulfilment status, method, exceptions, date; detail with timeline (all four dimensions), attempts/payments/refunds, invoice & packing slip, actions per transition; cancel (with automatic refund for prepaid) |
| **Customers** | List/search; detail (orders, addresses, notes); block/unblock (signs out everywhere). STAFF sees masked contact details |
| **Coupons** | Create/edit (type, value, cap, min order, window, total & per-customer limits, scope, public); redemptions with status (reserved/redeemed/released/reversed) |
| **Shipping Rates** | Zones, slabs, extra ₹/kg, state mapping; free-shipping threshold and heavy cap; packaging weight; serviceability rules per pincode (deliverable, COD, surface only), CSV import; preview calculator |
| **Restock Requests** | Waiting customers grouped by variant (count, oldest date, current availability); "Notify now" when back in stock |
| **Product Types / Categories / Techniques** | CRUD with image, slug, description, order, active, home/menu flags, tile link override, SEO; delete blocked while in use |
| **Inventory** | On hand / reserved / available per variant; recount, adjustment and damage write-off (reason required); movement ledger; inventory import; oversold alerts |
| **Returns & Refunds** | Return queue (decide → in transit → received → inspected → refund → close); refund creation with item allocation and capacity display (what is already reserved by pending refunds, what is still available per item, shipping, COD fee and payment); refund queue with failed/unknown handling and per-attempt detail; retry of failed refunds (only if capacity is still free); manual COD refunds with bank reference (cancellable until processed) |
| **COD Remittances** | Record courier remittances against orders; outstanding COD list; mismatch alerts |
| **Payment Exceptions** | Queue of excess/late captures, mismatches, stuck authorizations, failed/unknown refunds, dead webhooks/outbox, oversold, coupon over-limit; resolve/dismiss with note; manual reconcile |
| **Jobs & Webhooks** | Queue depths, failed jobs (retry), webhook inbox status (retry dead), outbox deliveries by consumer (pending, published but not completed, dead; retry dead), search queue depth, last scheduler runs |
| **Imports** | Upload catalogue or inventory sheet → validation preview with row outcomes and messages → confirm → progress → result file; resolve "needs review" rows; templates |
| **Media** | Library with state (processing/ready/failed/rejected), usage, retry, delete when unused |
| **CMS & Messages** | Hero/slides, announcement bar, home sections, reels, testimonials, FAQs, policy pages, Instagram moments; contact & custom-work inbox with private attachments |
| **Staff & Permissions** | Staff users, roles, MFA reset, revoke sessions |
| **Settings** | Store info/GSTIN, payment toggles (online/COD, fee, limits), order rules, tax settings, notification recipients |
| **Audit Logs** | Filterable log of admin mutations and security events |

---

## 8. Business rules (authoritative)

### 8.1 Pricing & tax
- Prices are **GST-inclusive** INR, stored in paise; `MRP ≥ price`; discount % = round((MRP − price) / MRP × 100).
- Each product needs an approved **HSN code and GST rate** before publication. GST rates were restructured in September 2025, so every rate must come from the accountant against the current schedule (decision D-1). The DB only checks 0–40 %.
- Invoice: CGST + SGST when the place of supply is the store's state (Kerala, `32`), otherwise IGST. Treatment of shipping and COD-fee charges: decision D-3.

### 8.2 Shipping
One algorithm (architecture.md §6.5): chargeable weight (actual vs volumetric + packaging) → zone slab → extra per kg beyond the last slab. **Free shipping** when (subtotal − coupon discount) ≥ ₹1,000 or a FREE_SHIPPING coupon applies; free shipping covers up to **10 kg**, and each extra kg is charged at the zone's extra rate. The COD fee is never waived.

Default rates (editable; decision D-13):
| Weight up to | Kerala | Rest of South | Rest of India | NE / J&K / islands |
|---|---|---|---|---|
| 500 g | ₹50 | ₹60 | ₹70 | ₹100 |
| 1 kg | ₹70 | ₹85 | ₹100 | ₹140 |
| 2 kg | ₹110 | ₹130 | ₹150 | ₹200 |
| 5 kg | ₹220 | ₹260 | ₹300 | ₹400 |
| each extra kg (`extra_per_kg`) | ₹40 | ₹45 | ₹55 | ₹75 |

Serviceability and COD availability are configured separately from the postal directory (decision D-6). Resin ships **surface only** until the courier confirms handling (D-7). Bulky frames require dimensions.

### 8.3 Stock
- `available = on hand − reserved`. You can only buy what is available; there are no backorders.
- Checkout reserves stock (30 minutes for online payment, until dispatch for COD/paid orders). Unpaid orders release it on expiry or cancellation. Dispatch consumes it (on hand decreases).
- Recounts and imports change on-hand only and never overwrite reservations. A recount below reserved is allowed (physical truth) but raises an **oversold** alert.
- Returns add stock back only for units inspected as sellable; damaged units are recorded but not restocked.

### 8.4 Coupons
- One coupon per order; code case-insensitive. Validation order: exists & active → time window → total capacity → per-customer limit (account, or guest email; best-effort for guests) → first-order-only → minimum order (eligible items) → scope.
- **Capacity is reserved atomically when the order is placed**, redeemed when payment is captured (or a COD order is placed), released if the unpaid order expires or is cancelled, and reversed (use restored) if a paid order is cancelled before dispatch (decision D-14).
- A coupon that expires while the customer is paying is still honoured for that order.
- If a late payment arrives after the last use was taken, the order is honoured at the price paid and flagged.

### 8.5 Order states (customer view)
The system tracks lifecycle, payment, fulfilment and returns separately (database.md §3.9). Customers see one derived label:

| Situation | Label |
|-----------|-------|
| Pending payment | "Awaiting payment" (with retry) |
| Payment authorized / unknown | "Payment processing" |
| Placed / confirmed, unfulfilled | "Order placed" / "Confirmed" |
| Packed / shipped / out for delivery / delivered | "Packed" / "Shipped" / "Out for delivery" / "Delivered" |
| Return open | "Return in progress" |
| Refund processed | "Refunded" / "Partially refunded" |
| Cancelled / expired | "Cancelled" / "Payment not completed" |

### 8.6 Cancellations, late payments, refunds
- Customers can cancel while the order is placed/confirmed **and not yet packed**. Staff can cancel until it is shipped. Prepaid cancellations are refunded in full automatically (including shipping and COD fee if any).
- A payment that arrives after the order expired: the order is restored if all items are still available; otherwise it is refunded in full and the customer is emailed. A payment for a cancelled order is always refunded. A duplicate (second) payment is refunded automatically.
- Refunds never exceed what was captured, per payment, per order, per item (what was paid for it after discounts), for shipping and for the COD fee. Refunds that are still pending or whose outcome is unknown count against these limits, so two staff members can never refund the same thing twice at the same time. A refund that definitively failed frees its amount; it can be retried only while that amount is still free. If money is refunded directly in Razorpay, no further refund can be issued on that payment until the system has reconciled Razorpay's refund records (usually within minutes). Shipping is refunded only for full cancellation before dispatch or merchant-fault returns (staff choice). The COD fee is refunded only for full cancellation before dispatch.
- Online refunds go back to the original payment method (5–7 working days). COD refunds are made by bank/UPI transfer with a recorded reference.

### 8.7 Publication gate (product readiness)
A product can be **published** (status ACTIVE, visible) only when all of the following are approved. Imported or new products start as **Draft**.

| Check | Rule |
|-------|------|
| Type & category | Assigned (category belongs to type) |
| Price & size | Every active variant has a price, MRP ≥ price (if MRP set), a normalised size/unit, and no `PRICE_MISSING` / `SIZE_CONFLICT` flag |
| Physical inventory | Every active variant has a **counted** on-hand quantity (`inventory_counted_at` set; ambiguous imported stock like "500KG" or "Stock Out" is never treated as counted) |
| Image | At least one `READY` cover image |
| Shipping data | Every active variant has a **measured** weight (estimated weights block publication); bulky variants have dimensions; shipping class set |
| Description | Non-empty description; no `DESCRIPTION_SUSPECT_COPY` flag (copied text must be reviewed and cleared) |
| Tax classification | HSN code and GST rate set and **approved** |
| Data flags | All import flags resolved |

Breaking a check on a published product is blocked; unpublish first.

### 8.8 Returns
Damaged, wrong, defective or missing items only, reported **within 48 hours of delivery** with photos (decision D-5). Steps: request → approve/reject → item returned (or not needed for "missing") → received → inspected → refund → closed. Quantities can never exceed what was delivered, across all requests.

### 8.9 COD
Enabled by setting (decision D-4): fee (default ₹40), order total ₹200–₹5,000, COD-enabled pincodes only. The order is placed immediately (stock reserved). Cash collected on delivery → remitted by the courier → recorded by staff. RTO (refused/undeliverable): stock restocked after inspection, order cancelled, no money collected.

### 8.10 Invoices
GST tax invoice issued **at dispatch** (decision D-2), numbered consecutively per financial year (`AQ/26-27/000001`), immutable. Corrections and post-dispatch refunds produce **credit notes** (`CN/26-27/000001`). The accountant approves the format before launch.

### 8.11 Accounts, guests & privacy
- Accounts are identified by **email**. Phone is a contact field at launch.
- Guest checkout needs no account. A guest order becomes visible in an account once the customer proves ownership of the order email (signup verification or the set-password link).
- Guest order management requires an email code to the order email.
- Marketing only with consent; unsubscribe in every marketing email; data export/deletion on request (DPDP Act 2023).

---

## 9. Notifications
Sent through the outbox (architecture.md §8.2). **At-least-once**: a rare duplicate email is possible; a missing email is not.

| Trigger | To |
|---------|----|
| Signup/login/guest-access/email-change codes | Customer |
| Password reset, set-password link | Customer |
| Order placed (prepaid captured or COD placed) | Customer + admin |
| Payment not completed (unpaid order expired) | Customer (with "shop again" link) |
| Confirmed / shipped (AWB) / delivered | Customer |
| Cancelled; refund requested; refund processed; refund for late/duplicate payment | Customer |
| Return decided / received / refunded | Customer |
| Back in stock | Restock-request subscribers |
| New payment exception, refund failed, oversold | Admin (email + bell) |
| Contact / custom-work message | Admin |
| Daily summary + low stock | Admin |

---

## 10. Non-functional requirements
| Area | Requirement |
|------|-------------|
| Performance | Lighthouse mobile ≥ 90; LCP < 2.5 s (4G); CLS < 0.1; API p95 < 300 ms |
| Correctness | No oversell; no refund above capture; no lost payment events; idempotent client retries; all money states reconciled daily |
| Availability & recovery | 99.9 % monthly; **RPO ≤ 5 min, RTO ≤ 4 h** (architecture.md §13) |
| SEO | SSR/ISR, unique titles, JSON-LD, sitemap, canonical, 301s |
| Accessibility | WCAG 2.1 AA, including the admin (contrast, keyboard, focus, reachable navigation) |
| Security | architecture.md §11; admin MFA; audit |
| Browsers | Last 2 versions of Chrome, Safari (iOS 16+), Firefox, Edge, Samsung Internet |
| Legal (India) | DPDP Act 2023 privacy notice & consent, GST invoices/credit notes, grievance contact, visible policies, tax-inclusive prices |

---

## 11. Open decisions (business inputs only)
Engineering defaults are shown; the build proceeds with them unless the client decides otherwise.

| # | Decision | Owner | Default until decided | Needed by |
|---|----------|-------|-----------------------|-----------|
| D-1 | HSN codes and GST rates per product (current schedule) | Accountant | Products stay draft (tax not approved) | Before publishing |
| D-2 | Invoice timing (dispatch vs payment) and format | Accountant | At dispatch | Phase 5 |
| D-3 | GST treatment of shipping and COD-fee charges | Accountant | Same rate as the order's highest-rate item | Phase 5 |
| D-4 | COD on/off, fee, min/max order value | Owner | On, ₹40, ₹200–₹5,000 | Phase 4 |
| D-5 | Return/refund policy wording, window, merchant-fault shipping refund | Owner | 48 h, damaged/wrong/defective/missing, shipping refunded on merchant fault | Phase 5 |
| D-6 | Serviceability policy: deliver to all pincodes unless blocked, or only listed ones; COD pincodes | Owner + courier | All except blocked; COD everywhere serviceable | Phase 4 |
| D-7 | Courier(s) and whether resin/hardener can travel by air (dangerous goods) | Owner + courier | Surface only for resin | Phase 4 |
| D-8 | Sell 9–30 kg resin packs online? | Owner | No (draft) | Catalogue cleanup |
| D-9 | Prepaid RTO refund: full, or minus forward shipping? | Owner | Full refund of items; shipping not refunded | Phase 5 |
| D-10 | Product data: photos, measured weights/dims, counted stock, corrected descriptions/sizes/prices (catalog.md §4) | Owner | Affected products stay draft | Before launch |
| D-11 | Pigment swatch hex colours | Owner | Sampled from photos, approved by owner | Before launch |
| D-12 | Domain and sending email domain | Owner | `artq.in` | Phase 0 |
| D-13 | Free-shipping threshold, heavy cap, slab rates | Owner | ₹1,000; 10 kg; table §8.2 | Phase 4 |
| D-14 | Restore coupon use when a paid order is cancelled before dispatch? | Owner | Yes | Phase 4 |
| D-15 | Who handles payment exceptions and COD remittance day-to-day; escalation phone | Owner | Owner (business hours) | Before launch |
| D-16 | Razorpay account: KYC, auto-capture setting, settlement account | Owner | Auto-capture on | Phase 4 (test), launch (live) |
| D-17 | Funding policy for a payment first seen **partially refunded** at Razorpay (e.g. refunded in the dashboard before ArtQ processed it) | Owner | Hold for manual review; staff may refund the remainder; the order is not fulfilled automatically | Phase 4 |
