# ArtQ: Product Requirements Document (PRD)

> Version 1.0 · Status: Draft for build · Owner: ArtQ / Eayila Consultancy
> Reference prototype: https://qcraft-nine.vercel.app/ · Mobile reference: `../ArtQ Site Ref.png`

---

## 1. Vision & goals

**Vision:** the go-to online store in India for resin artists and hobbyists, where they can buy everything for a resin project
(resin, moulds/frames, pigments, glitters, tools) in one place, with fast delivery and trustworthy quality.

### 1.1 Business goals (first 6 months after launch)

| Goal | Metric | Target |
|------|--------|--------|
| Sell online directly | Orders / month | 300+ |
| Grow basket size | Average order value (AOV) | ≥ ₹1,100 (just above free-shipping threshold) |
| Convert mobile visitors | Mobile conversion rate | ≥ 1.5 % |
| Reduce manual work | Orders processed without phone/WhatsApp back-and-forth | ≥ 90 % |
| Build a list | Newsletter + account sign-ups | 2,000+ |

### 1.2 Non-goals for v1

- Multi-vendor marketplace (only ArtQ sells).
- International shipping (India only; the schema supports countries for later).
- Native mobile apps (the website must be excellent on mobile instead; ~80 % of traffic is expected on phones).
- Multi-language (English only in v1; copy is kept in one place so Hindi/Malayalam can be added later).
- Live chat (a WhatsApp click-to-chat button is used instead).

---

## 2. Users (personas)

| Persona | Description | What they need |
|---------|-------------|----------------|
| **Hobbyist Hema** (primary) | 22–40, learns resin art from Instagram/YouTube, buys small quantities (300 g resin, a few pigments, a 6×6 frame) | Clear sizes/prices, beginner combos, reels showing results, free shipping nudge, COD/UPI |
| **Pro Artist Pranav** | Sells resin art / runs workshops, buys 3–30 kg resin and frames in bulk | Quick re-order, bulk sizes, stock availability, GST invoice |
| **Preservation Priya** | Makes wedding-garland/flower preservation frames | Teakwood/double frames, silica gel, custom work enquiry |
| **Gift Buyer Gautam** | Buys a frame or kit as a gift, one-time | Guest checkout, no forced signup, order tracking link |
| **Admin Anu** (store owner/staff) | Manages catalogue, stock and orders from a laptop or phone | Fast product entry, Excel import, order list with filters, print invoice/label, low-stock alerts |

---

## 3. Information architecture (site map)

```
/                               Home
/shop                           All products (filters: type, category, technique, price, availability; sort)
/type/:slug                     All products in a Type (e.g. /type/pigments)
/category/:slug                 All products in a Category (e.g. /category/gel-pigments)
/technique/:slug                Products tagged with a technique (reference calls it /occasion/:slug)
/collection/:slug               Curated collection
/new-arrivals                   Products flagged New Arrival
/trending                       Products flagged Trending + reels
/product/:slug                  Product detail page (PDP)
/search?q=                      Search results
/cart                           Cart
/checkout                       Checkout (address → shipping → payment) [new route; reference does it inside /cart]
/checkout/success/:orderNumber  Thank-you page
/wishlist                       Wishlist
/login  /signup  /forgot-password  /reset-password  /guest-login
/account                        Profile
/account/addresses              Address book (reference: /address)
/orders                         My orders
/orders/:orderNumber            Order detail
/orders/:orderNumber/track      Tracking timeline
/about  /contact  /faqs  /custom-work
/terms  /privacy-policy  /shipping-policy  /return-policy  /cancellation-policy
/404                            Not found

/admin                          Admin dashboard (separate app, see §7)
```

URL rules:
- Slugs are lowercase, hyphenated, unique per entity (`2-1-epoxy-resin`, `teak-wood-frame-1-inch`).
- Old slugs are kept in a `slug_redirects` table and 301-redirected when an admin renames a product.
- Filters live in the query string so filtered pages can be shared: `/shop?type=pigments&category=gel-pigments&sort=price_asc&page=2`.

---

## 4. Global elements (on every storefront page)

### 4.1 Announcement bar
- Full-width strip at the very top, brand gradient background, white 12–13 px text.
- Text is a **marquee** (continuous horizontal scroll) of admin-editable messages, separated by "•".
  Default: `Shipping all over India • Free shipping on orders above ₹1000 • COD available`.
- Pauses on hover. Respects `prefers-reduced-motion` (static, first message only).
- Admin: Settings → Announcement bar (list of messages, on/off, speed).

### 4.2 Header
| Area | Mobile (< 768 px) | Desktop (≥ 1024 px) |
|------|-------------------|---------------------|
| Left | ☰ hamburger, 🔍 search icon | Logo |
| Centre | Logo (ArtQ, 44 px tall) | Nav: HOME · SHOP ▾ · SHOP ALL · NEW ARRIVALS · ABOUT US · CONTACT |
| Right | 👤 account, ♡ wishlist (count badge), 🛒 cart (count badge) | 🔍 search, 👤 LOGIN / SIGN UP or name, ♡ (badge), 🛒 (badge) |

- **Sticky** on scroll; gains a soft shadow after 10 px scroll; hides on scroll-down and reappears on scroll-up (mobile only).
- **SHOP ▾ mega-menu (desktop hover / mobile accordion):** columns per Type, each listing its Categories, plus a promo image.
- **Mobile drawer** (slides in from left, 85 % width): search field, Types as accordion → Categories, links (New arrivals, Trending, About, Contact, FAQs), account links, WhatsApp/Instagram icons.
- **Badges** show item counts (cart = total quantity, wishlist = number of products); hidden when 0? **No.** The reference shows "0", so keep it.
- **Search** opens a full-width overlay with an input, recent searches (localStorage) and live suggestions (debounced 250 ms, min 2 chars) showing product thumbnail, name and starting price. Enter → `/search?q=`.

### 4.3 Footer (dark navy `#111827`)
1. **Newsletter band:** "SUBSCRIBE TO OUR NEWSLETTER", email input, "SUBSCRIBE" button. Validation; success message "You're subscribed! 🎉"; duplicate email gets "You're already subscribed".
2. Logo + tagline: *"Handcrafted resin art and wooden frames, bringing natural beauty into your everyday spaces."*
3. Three link columns:
   - **TYPE:** generated from active Types (Resins, Wooden Frames, Multiwood Frames, Hoops, Pigments, Glitters, Silica Gel, Resin Art Essentials, Custom Work)
   - **CONNECT:** About Our Craft, Contact Us, FAQs, Instagram, WhatsApp
   - **POLICIES:** Terms & Conditions, Privacy Policy, Shipping Policy, Return & Refund Policy, Cancellation Policy
4. Payment icons (UPI, Visa, Mastercard, RuPay, COD) and social icons.
5. Bottom line: `© {current year} ART Q. ALL RIGHTS RESERVED.` · `powered by Eayila Consultancy`.

### 4.4 Floating elements
- **WhatsApp button** (bottom-right, 56 px circle) opens `https://wa.me/<number>?text=Hi ArtQ, I have a question about …`. On PDP it pre-fills the product name.
- **Mini-cart drawer** slides in from the right whenever an item is added (see §5.7).
- **Toast notifications** (bottom-centre on mobile, top-right on desktop) for add-to-wishlist, errors, etc.

---

## 5. Storefront pages in detail

### 5.1 Home `/`
Sections in order (each section is admin-configurable: on/off, order, title):

1. **Hero**
   - Full-width autoplaying muted looping video (`hero-video.mp4`, ≤ 4 MB, H.264 + WebM), poster image shown until loaded.
   - Overlay: big logo-style word **"ARTQ"** (Playfair Display, white, letter-spaced) + subtitle **"WOOD MOULDS & RESINS"** (Tenor Sans, letter-spacing 0.3em).
   - Optional CTA button "Shop Now" → `/shop`.
   - Height: 60 vh mobile, 85 vh desktop. On slow connections (`navigator.connection.saveData`) show the poster only.
   - Admin can switch to an image carousel (up to 5 slides, each with image, mobile image, heading, sub-heading, CTA text, link).

2. **"CHECK OUT OUR RANGE": Product Category**
   - Small caps label, then serif heading "Product Category" with horizontal teal lines on both sides (signature section-title style; see design-system).
   - Grid of **circular tiles** (image in circle with 2 px teal ring on hover, name under it).
   - 3 columns mobile, 5 tablet, 9 desktop (single row) or 2 rows on smaller desktops.
   - Tiles = active Types sorted by `sort_order`: Resins, Wooden Frames, Multiwood Frames, Hoops, Silica Gel, Pigments, Glitters, UV Resin, More…
   - Click → `/type/:slug`. "More.." → `/shop`.

3. **New Arrivals**
   - Heading "New Arivals" in reference (**typo, fix to "New Arrivals"**), sub-heading "Explore our newly launched products".
   - Product cards (see §6.1), 2 columns mobile, 4–5 desktop; shows up to 8; "View all →" link to `/new-arrivals`.
   - Source: products with `is_new_arrival = true` ordered by `new_arrival_rank`, then newest.

4. **Trending now: "Discover our most popular picks"**
   - Grid (2 col mobile, 4 desktop) of **vertical 9:16 reel cards**: muted autoplay when ≥ 50 % in viewport (IntersectionObserver), only one plays at a time on mobile.
   - Bottom overlay on each reel: product thumbnail + product name + price (e.g. "Small mom frame – Rs. 150.00"). Tap → opens reel in a full-screen viewer with sound toggle and an **"Add to cart" / "View product"** button.
   - Source: `reels` table (active, ordered). Falls back to trending products grid if no reels.

5. **Shop by Technique** (new, optional): horizontal scroll cards for techniques (Deep Pour Casting, Flower Preservation, Jewellery, Coasters…) → `/technique/:slug`.

6. **Stories with our product (Testimonials)**
   - Single-card carousel: quote in italics, 5 gold stars (`#f5b301`), customer name, optional city and photo. ‹ › arrows + swipe + dots; auto-advance every 6 s, pauses on hover/touch.
   - Source: `testimonials` table.

7. **Instagram moments** (optional): 6-image grid linking to Instagram posts (setting `INSTAGRAM_MOMENTS`).

8. Footer (newsletter is part of footer).

**Home SEO:** title "ArtQ: Epoxy Resin, Wooden Frames, Pigments & Resin Art Supplies India", meta description, Organization + WebSite (SearchAction) JSON-LD.

### 5.2 Listing pages: `/shop`, `/type/:slug`, `/category/:slug`, `/technique/:slug`, `/collection/:slug`, `/new-arrivals`, `/trending`, `/search`
One shared **ProductListing** template:

- **Banner**: title (Type/Category name), optional description (HTML from admin, collapsible "Read more" after 3 lines), optional banner image.
- **Breadcrumb:** Home › Shop › Pigments › Gel Pigments.
- **Category chips** (on Type pages): horizontal scroll of the Type's categories; active chip filled teal.
- **Toolbar:** result count ("48 products"), Sort dropdown, Filter button (mobile) / left sidebar (desktop ≥ 1024 px).
- **Sort options:** Featured (default: `sort_order`, then trending, then newest), Newest, Price: Low → High, Price: High → Low, Name A–Z, Best selling.
- **Filters:**
  - Type (checkbox list, only on /shop & /search)
  - Category (checkbox list, scoped to selected Type)
  - Technique (checkbox)
  - Price range (dual slider + min/max inputs, bounds from data)
  - Size (chips, built from variant sizes in the current result set, e.g. 300 gm, 6X6, 20gm)
  - Colour (swatches using `color_hex` when available)
  - Availability: In stock only (toggle)
  - On sale: MRP > price (toggle)
  - Mobile: filters open as a bottom sheet with "Clear all" and "Show 48 results" buttons; desktop: applied instantly.
  - Active filters shown as removable chips above the grid.
- **Grid:** product cards, 2 col (mobile) / 3 col (tablet ≥ 768) / 4 col (≥ 1024) / 5 col (≥ 1440). Gap 12 px mobile, 20 px desktop.
- **Pagination:** "Load more" button (24 per page) + page number in URL (`?page=2`) so it is crawlable; infinite scroll is **not** used (bad for footer access & SEO).
- **Empty state:** illustration, "No products match these filters", "Clear filters" button, plus 4 trending products.
- **Loading:** skeleton cards (grey shimmer) matching card layout.
- **SEO:** each Type/Category has its own meta title/description; `rel=canonical` strips sort/filter params except `page`; filtered combos are `noindex`.

### 5.3 Product detail page (PDP) `/product/:slug`

**Layout:** mobile = stacked; desktop = 2 columns (gallery 55 %, info 45 %, info column sticky).

**Gallery**
- Main image 1:1 (square), swipeable on mobile with dots; desktop: vertical thumbnails on the left + hover zoom (2×) on main image; click opens a full-screen lightbox with pinch-zoom.
- Supports video items (e.g. a pouring video) in the gallery.
- When a variant with its own image is selected, the gallery jumps to that image.
- Badges on image: "NEW", "-25 %" (when MRP > price), "Only 3 left" (stock ≤ low-stock threshold), "Out of stock".

**Info column (top to bottom)**
1. Breadcrumb.
2. Product name (H1, Playfair 24/32 px).
3. Rating summary ★★★★☆ 4.6 (23 reviews), Phase 9; hidden until reviews exist.
4. **Price block:** `₹849` (bold, 24 px) + `~~₹999~~` (grey strike-through, only if MRP > price) + `15 % OFF` pill (teal). Below: "Inclusive of all taxes".
5. **Variant selectors:** one selector per option that has more than one distinct value, in the order **Size → Colour → Thickness**:
   - Size/Thickness: pill buttons (`300 gm`, `750 gm`…). Unavailable combinations are struck-through (still clickable to show "Notify me").
   - Colour: round swatches (`color_hex`) with name tooltip; falls back to pills if no hex.
   - If a product has **only one variant**, no selector is shown.
   - Selected variant is reflected in the URL `?variant=<sku>` so links to a size are shareable.
   - Size chart link (if the category/product has a size chart) opens a modal.
6. **Stock message:** "In stock" (green) / "Only 3 left, order soon" (amber, when `stock ≤ low_stock_threshold`, default 5) / "Out of stock" (red).
7. **Quantity stepper** (– 1 +), min 1, max = min(stock, 50).
8. **Buttons:** `ADD TO CART` (primary, full width on mobile) and `BUY NOW` (secondary: adds and goes straight to checkout). ♡ wishlist toggle icon button.
   - Out of stock: buttons replaced by **"Notify me when available"**, which asks for email/phone (pre-filled when logged in) and creates a `stock_notification`.
9. **Delivery check:** pincode input → "Delivery by Thu, 9 Oct · Shipping ₹60 (free above ₹1000)" (Phase 1: estimated from state zone; Phase 9: live Shiprocket serviceability). Also shows whether COD is available.
10. **Trust row:** icons for "Free shipping over ₹1000", "Secure payments", "Easy returns on damage", "Made in India".
11. **Accordions:**
    - *Description* (rich text)
    - *Product details* (bullet list from `product_details[]`)
    - *Specifications & care* (bullet list from `specifications_care[]`)
    - *How to use* (optional rich text, e.g. mixing ratio 2:1)
    - *Shipping & returns* (global text from settings)
12. **Techniques:** tag chips linking to `/technique/:slug`.

**Below the fold**
- "Frequently bought together" (admin-chosen related products, else same Type), with "Add all to cart".
- "You may also like" carousel (same Category, excluding current).
- Recently viewed (localStorage, last 10).
- Reviews section (Phase 9).

**Mobile sticky bar:** once the main Add-to-cart button scrolls out of view, a bottom bar shows price + "ADD TO CART".

**SEO:** title = `meta_title || "{name} | ArtQ"`; Product JSON-LD with offers per variant (price, availability, SKU), BreadcrumbList JSON-LD; Open Graph image = cover image.

### 5.4 Search `/search?q=`
- Searches product name, category name, type name, SKU, tags, description (Postgres full-text + trigram for typos, e.g. "reisn" → resin).
- Same listing template with filters.
- Zero results: "No results for 'xyz'", suggestions ("Try resin, frames, pigments"), trending products.
- Every query is logged (`search_logs`) so admin can see what people look for.

### 5.5 Cart `/cart`
- Line items: image, name, variant label ("750 gm"), unit price, quantity stepper, line total, remove (with undo toast), "Move to wishlist".
- Stock validation: if quantity > stock, the item is clamped with a warning; out-of-stock items are shown greyed with "Remove" and excluded from totals.
- **Free-shipping progress bar:** "Add ₹151 more for FREE shipping" → filled bar → "🎉 You've unlocked free shipping".
- **Coupon box:** input + Apply; shows applied coupon chip with remove ×; error messages (expired, min order not met, already used, invalid). "View available coupons" lists active public coupons.
- **Order summary:** Subtotal (MRP total), Discount on MRP, Coupon discount, Shipping (estimated; "Calculated at checkout" if no pincode), **Total**. "You save ₹X" line in green.
- CTA: `PROCEED TO CHECKOUT`. Below: "Continue shopping".
- Empty cart: illustration + "Your cart is empty" + "Start shopping" + trending products.
- Cart persists: guests via `cart_token` cookie (server cart, 30 days); on login the guest cart **merges** into the user cart (quantities summed, clamped to stock).

### 5.6 Checkout `/checkout`
Single page, 3 collapsible steps (mobile: one at a time; desktop: steps on the left, sticky order summary on the right).

**Step 1: Contact**
- Logged in: shows name/email/phone, "Not you? Log out".
- Guest: email + phone (10-digit Indian mobile, validated). Option "Create an account for faster checkout" (sends set-password link after order). Optional OTP verification of phone/email for guest (setting).
- Returning email detected: "Looks like you have an account. Log in?" (non-blocking).

**Step 2: Shipping address**
- Saved addresses as selectable cards (default pre-selected) + "Add new address".
- Address form: Full name*, Phone*, Pincode* (6 digits; auto-fills City & State via pincode lookup table / India Post API), Address line 1 (house, building)*, Address line 2 (area, street), Landmark, City*, State* (dropdown of Indian states/UTs), Address type (Home/Work/Other), "Save this address", "Make default".
- "Billing address same as shipping" (checked); else billing form. Optional **GSTIN** + business name for GST invoice.

**Step 3: Shipping & payment**
- Shipping method: "Standard delivery: ₹60 · 4–7 days" (calculated from weight & zone; free if eligible). Future: Express.
- Payment method radio:
  - **Pay online** (UPI, cards, netbanking, wallets) via Razorpay (default, recommended).
  - **Cash on Delivery** (if enabled in settings, order total between COD min/max, e.g. ₹200–₹5,000, pincode COD-serviceable). Optional COD fee (e.g. ₹40) shown.
- Order notes (optional, 500 chars), e.g. "Gift, please don't include invoice".
- Terms checkbox: "I agree to the Terms & Conditions and Return Policy".
- `PLACE ORDER · ₹1,349` button.

**Order summary (right/sticky):** items (collapsible on mobile), coupon box, subtotal, discount, shipping, COD fee, total, savings.

**Payment flow:**
1. Click Place order → server re-validates cart (prices, stock, coupon, shipping) → creates order `PENDING_PAYMENT` and reserves stock → creates Razorpay order → returns `razorpay_order_id`.
2. Razorpay Checkout modal opens (prefilled name/email/phone, theme colour `#00a99d`).
3. On success → client sends `{razorpay_payment_id, razorpay_order_id, razorpay_signature}` to `/orders/verify` → server verifies HMAC signature → marks order `PLACED`/`PAID` → clears cart → redirect to success page.
4. Webhook `payment.captured` also marks it paid (idempotent), covering users who close the tab.
5. Payment failed/closed → order stays `PENDING_PAYMENT`, user sees "Payment didn't go through. Retry payment / Choose COD". Unpaid orders expire after 30 min (stock released).
6. COD → order goes directly to `PLACED` with `payment_status = PENDING`.

### 5.7 Mini-cart drawer
- Opens on add-to-cart: "✓ Added to cart", the added item, cart subtotal, free-shipping progress, `VIEW CART` and `CHECKOUT` buttons, and "You may also like" (2 small products).
- Closes on overlay click / Esc / swipe right.

### 5.8 Order success `/checkout/success/:orderNumber`
- ✓ animation, "Thank you, Hema! Your order **AQ-10234** is placed."
- Summary: items, total, payment method, delivery address, estimated delivery date.
- Buttons: "Track order", "Continue shopping", "Download invoice" (after payment).
- Guest: "Create a password to track orders easily" (one field, account created with the same email).
- Fires analytics `purchase` event (GA4 + Meta Pixel) once only.

### 5.9 Auth pages
| Page | Fields | Behaviour |
|------|--------|-----------|
| `/login` | Email or phone, password, "Remember me" | Also **"Login with OTP"** tab: enter email/phone → 6-digit OTP (valid 10 min, 5 attempts, resend after 30 s). Redirects to `?next=` or previous page. 5 failed password attempts → 15-min lock. |
| `/signup` | Full name, email, phone, password (min 8, 1 letter + 1 number), confirm, newsletter opt-in | Sends OTP to email to verify (reference: `verify-signup`). Account active after verification. |
| `/guest-login` | Email or phone | OTP login without password, used to view guest orders (reference: `verify-guest-login`). |
| `/forgot-password` | Email | Always replies "If an account exists, we've sent a reset link" (no account enumeration). Link valid 30 min, single use. |
| `/reset-password?token=` | New password ×2 | Logs out all other sessions. |
| Google sign-in | (Phase 9) | One-tap. |

### 5.10 Account area (requires login)
- **Profile** `/account`: name, email (change requires OTP), phone, password change, newsletter preference, delete account (soft delete + anonymise after 30 days).
- **Addresses** `/account/addresses`: list, add, edit, delete, set default (max 10).
- **Orders** `/orders`: list with order number, date, item thumbnails, total, status pill; filter by status; pagination.
- **Order detail** `/orders/:orderNumber`: items, price breakup, address, payment info, invoice download, **Cancel order** (allowed while status ∈ PLACED, CONFIRMED; reason required), **Report a problem** (damaged/wrong item within 48 h of delivery; upload up to 4 photos, which creates a return request), **Buy again** (adds all items to cart).
- **Tracking** `/orders/:orderNumber/track`: vertical timeline Placed → Confirmed → Packed → Shipped (courier + AWB + "Track on courier site" link) → Out for delivery → Delivered, with timestamps. Public tracking for guests via link with signed token in the email.
- **Wishlist** `/wishlist`: grid of cards with "Move to cart" (opens variant picker if multiple variants) and remove. Guests: wishlist stored in localStorage and merged on login.

### 5.11 Content pages
- **About** (`/about`): story, maker photos, values (natural wood, made in India, artist-tested), Instagram embed.
- **Contact** (`/contact`): form (name, email, phone, subject select [Order issue, Product question, Bulk/wholesale, Custom work, Other], message, optional order number) → saved to `contact_messages` + email to admin; address, phone, WhatsApp, email, business hours, Google map embed.
- **Custom work** (`/custom-work`): enquiry form for custom-size frames / resin preservation (size, wood, quantity, reference photo upload, budget, date needed).
- **FAQs** (`/faqs`): grouped accordions (Orders, Shipping, Payments, Products & usage, Returns) from `faqs` table; FAQPage JSON-LD.
- **Policies:** Terms, Privacy, Shipping, Return & Refund, Cancellation. Rich text managed in admin (`cms_pages`).
- **404:** friendly message, search box, links to popular Types.

---

## 6. Shared components (behaviour)

### 6.1 Product card
- Square image (cover image; on desktop hover shows 2nd image with a fade).
- Badges top-left: NEW / -X% / Out of stock. ♡ top-right (toggles wishlist; requires no login, guest wishlist in localStorage).
- Name (2 lines max, ellipsis), centred.
- Price: "From ₹190" when variants have different prices; else "₹250.00". Strike-through MRP when applicable. Reference format "Rs. 250.00"; **we use "₹250"** (no decimals when whole).
- `ADD` button (teal pill, full card width on mobile):
  - Single variant → adds to cart directly, opens mini-cart.
  - Multiple variants → opens a **quick-add bottom sheet** (mobile) / popover (desktop) to choose size/colour, then add.
  - Out of stock → "NOTIFY ME".
- Whole card (except buttons) links to PDP.

### 6.2 Section title
Centred serif heading with thin teal lines extending left and right; optional small-caps eyebrow above and sub-heading below (see design-system.md §5).

### 6.3 Price formatting
`Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', maximumFractionDigits: 0|2})` → ₹1,499 / ₹13,100 / ₹8,050.50.

---

## 7. Admin panel (`admin.artq.in` or `/admin`)

Login: email + password + (optional) TOTP 2FA. Roles: **SUPER_ADMIN** (everything), **ADMIN** (everything except settings/staff), **STAFF** (orders & stock only). Layout: left sidebar, top bar with global search (orders by number/phone, products by name/SKU), notifications bell.

| Module | Features |
|--------|----------|
| **Dashboard** | Today / 7 d / 30 d: revenue, orders, AOV, new customers; sales line chart; orders by status; top 10 products; low-stock list; pending orders needing action; recent orders |
| **Products** | Table (image, name, type, category, price range, total stock, status, new/trending toggles), search, filters, bulk actions (activate, deactivate, mark new/trending, delete); **Create/Edit form**: name, slug (auto), type, category, techniques (multi), short + long description (rich text), product details (repeatable list), specs & care (repeatable list), how-to-use, images (drag-drop multi-upload, reorder, set cover, alt text), video, **variants grid** (size, colour + hex, thickness, SKU, price, MRP, stock, low-stock threshold, weight g, variant image, active), HSN code, GST %, related products, flags (active, new arrival, trending, featured), SEO (meta title/desc/keywords, OG image), preview link; duplicate product |
| **Import / Export** | Upload `.xlsx` in the ArtQ template (see catalog.md) → **dry-run preview** with row-level errors/warnings → confirm import (create or update by SKU) → import report. Export all products/variants to xlsx. Download blank template. |
| **Inventory** | Variant-level stock table with inline edit, bulk stock update via CSV, stock movement history (who/when/why: order, cancel, manual adjust, import), low-stock alerts |
| **Types / Categories / Techniques / Collections** | CRUD with image, slug, description, sort (drag), active, SEO, size chart |
| **Orders** | Table with filters (status, payment status, method, date range, search); detail page: items, customer, addresses, payment (Razorpay IDs), timeline, internal notes, **status changes** (confirm, pack, ship with courier + AWB + tracking URL, deliver, cancel with reason & auto-refund for prepaid), partial/full refund, edit shipping address before packing, print **invoice** (GST) & **packing slip/label** (PDF), resend email |
| **Returns** | Requests with photos, approve/reject, refund amount, restock toggle |
| **Customers** | List (name, email, phone, orders, total spent, last order), detail (orders, addresses, wishlist, notes), block/unblock |
| **Coupons** | CRUD: code, type (% / flat / free shipping), value, max discount, min order, start/end, total limit, per-user limit, first-order-only, applicable types/categories/products, visible-in-cart flag; usage stats |
| **Shipping** | Zones (e.g. Kerala/local, South India, Rest of India, North-East & J&K) with weight slabs and rates; free-shipping threshold; COD on/off, fee, min/max; packaging weight; non-serviceable pincodes |
| **Content** | Hero/slides, announcement bar, home section order, reels (upload video/thumbnail, link product), testimonials, FAQs, CMS pages (policies/about), Instagram moments, navigation menu |
| **Marketing** | Newsletter subscribers (export CSV), restock requests (grouped by variant, "notify now"), abandoned carts (with contact, value, "send reminder"), search terms report |
| **SEO** | Per-path meta overrides, redirects (301), sitemap regenerate, robots preview |
| **Messages** | Contact form & custom-work enquiries inbox with status (new/replied/closed) |
| **Settings** | Store info (name, GSTIN, address, phone, email, WhatsApp), payment (Razorpay keys, enable online/COD), tax (prices inclusive of GST), email templates, staff users & roles, audit log |

---

## 8. Business rules (authoritative)

### 8.1 Pricing & tax
- All prices are **GST-inclusive** retail prices in INR. Stored in paise.
- `mrp` optional; if present must be ≥ `price`. Discount % = round((mrp − price) / mrp × 100).
- Each product has an `hsn_code` and `gst_rate` (frames 12 %, resin/pigments 18 %; confirm with CA) used only for the invoice breakup (taxable value = price / (1 + rate)).
- Invoice shows CGST+SGST when shipping state = store state (Kerala), otherwise IGST.

### 8.2 Shipping
- Shipping is charged per order, by **total chargeable weight** = Σ(variant.weight_g × qty) + packaging weight (setting, default 100 g), rounded up to the next slab.
- Rate = slab rate of the destination **zone** (from state). Default table (editable):

| Weight up to | Kerala | Rest of South | Rest of India | NE / J&K / islands |
|---|---|---|---|---|
| 500 g | ₹50 | ₹60 | ₹70 | ₹100 |
| 1 kg | ₹70 | ₹85 | ₹100 | ₹140 |
| 2 kg | ₹110 | ₹130 | ₹150 | ₹200 |
| 5 kg | ₹220 | ₹260 | ₹300 | ₹400 |
| each extra kg | ₹40 | ₹45 | ₹55 | ₹75 |

- **Free shipping** when cart subtotal **after coupon discount** ≥ ₹1,000 (setting `FREE_SHIPPING_THRESHOLD`). Heavy-item exception: if weight > 10 kg (e.g. 30 kg resin), free shipping covers up to 10 kg and extra kg are charged (setting, can be turned off).
- A `FREE_SHIPPING` coupon makes shipping 0 regardless.
- Variants missing weight use the category default weight; import warns about missing weights.

### 8.3 Stock
- Stock is tracked per variant. `stock` can never go below 0 (DB check constraint).
- Stock is **reserved** (decremented) when an order is created (`PENDING_PAYMENT`), released if payment fails/expires (30 min) or order cancelled; for COD reserved at placement.
- Every change writes a row in `inventory_movements`.
- When a variant goes from 0 → >0, all pending `stock_notifications` for it are emailed (job) and marked notified.
- Admin gets a daily low-stock email (variants with stock ≤ threshold).

### 8.4 Coupons
- Code is case-insensitive, stored upper-case. One coupon per order.
- Validation order: exists & active → within date window → total usage limit → per-user limit (by user id or email/phone for guests) → first-order-only → min order value (on eligible items subtotal) → eligibility scope.
- Percentage discounts capped by `max_discount`. Discount never exceeds eligible subtotal.
- Discount is distributed proportionally across eligible order items (stored per item, needed for partial refunds & GST invoice).
- Redemption is recorded only when the order is paid/placed; released if cancelled before shipping.

### 8.5 Orders & statuses
```
PENDING_PAYMENT ──pay──▶ PLACED ──▶ CONFIRMED ──▶ PACKED ──▶ SHIPPED ──▶ OUT_FOR_DELIVERY ──▶ DELIVERED
      │                    │            │                                                     │
      └─expire─▶ EXPIRED   └──cancel────┴──▶ CANCELLED                                       └─▶ RETURN_REQUESTED ─▶ RETURNED / RETURN_REJECTED
                                                                                    (refund) ─▶ payment_status = REFUNDED / PARTIALLY_REFUNDED
```
- Order number format: `AQ` + 5+ digit sequence starting at 10001 (`AQ10001`). Human-friendly, not guessable for tracking (tracking also needs email/phone or signed token).
- Customer can cancel only in PLACED/CONFIRMED. Prepaid cancellations auto-refund via Razorpay (full amount).
- Returns: only for damaged/wrong/defective items, reported within **48 h of delivery** with photos (resin is a chemical, so there are no change-of-mind returns; confirm policy).
- Every status change → row in `order_status_history` + customer email (and SMS/WhatsApp in Phase 9).

### 8.6 Accounts & privacy
- Email is unique and required for accounts; phone unique if present.
- Guest orders are linked to an account automatically when the user later signs up with the same verified email.
- Passwords hashed with argon2id. Sessions: 15-min access token + 30-day refresh cookie.
- Marketing emails only with consent (newsletter opt-in). Unsubscribe link in every marketing mail.

---

## 9. Notifications (emails; SMS/WhatsApp later)

| Trigger | To | Template |
|---------|----|----------|
| Signup OTP / login OTP | Customer | `otp` |
| Welcome after verify | Customer | `welcome` (with first-order coupon, optional) |
| Password reset | Customer | `password_reset` |
| Order placed | Customer + admin | `order_placed` (items, totals, address) |
| Payment failed (after 15 min) | Customer | `payment_failed` (retry link) |
| Order confirmed / shipped (AWB + link) / delivered | Customer | `order_status` |
| Order cancelled / refunded | Customer | `order_cancelled`, `refund_processed` |
| Back in stock | Subscriber | `back_in_stock` |
| Abandoned cart (1 h and 24 h, only with consent/contact) | Customer | `abandoned_cart` |
| Contact / custom-work enquiry | Admin | `admin_enquiry` |
| Daily low stock / daily sales summary | Admin | `admin_low_stock`, `admin_daily_summary` |

Emails are branded (logo, teal header, footer with policies), mobile-friendly, plain-text fallback.

---

## 10. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Performance | Lighthouse mobile ≥ 90 Performance, LCP < 2.5 s on 4G, CLS < 0.1, INP < 200 ms; product images WebP/AVIF, responsive `srcset`; API p95 < 300 ms |
| SEO | SSR/ISR pages, unique titles/descriptions, JSON-LD (Product, BreadcrumbList, Organization, FAQPage), XML sitemap, robots.txt, canonical URLs, 301 redirects on slug change |
| Accessibility | WCAG 2.1 AA: colour contrast, keyboard navigation, focus rings, alt text, ARIA on carousels/drawers, form labels & errors |
| Security | OWASP top 10; HTTPS only; rate limits; Razorpay signature + webhook verification; server-side price calculation (never trust client totals); admin 2FA; audit log |
| Reliability | 99.9 % uptime; daily DB backups (7 daily + 4 weekly), point-in-time recovery; idempotent payment handling |
| Browser support | Last 2 versions of Chrome, Safari (iOS 15+), Firefox, Edge, Samsung Internet |
| Legal (India) | Privacy policy per DPDP Act 2023, consent for marketing, GST invoice, grievance officer contact, return/refund policy visible, prices incl. taxes |
| Analytics | GA4 e-commerce events (view_item_list, view_item, add_to_cart, begin_checkout, add_payment_info, purchase), Meta Pixel + Conversions API, Search Console |

---

## 11. Open questions for the client

1. Confirm **GST rates & HSN codes** per product type and the store's GSTIN/registered address (state).
2. COD: allowed? fee? limits?
3. Return policy wording (damaged-only?) and cancellation window.
4. Courier: self-ship (manual AWB) at launch, or Shiprocket integration from day one?
5. Large resin packs (9–30 kg) from the older sheet: are they sold online? (Latest sheet stops at 6 kg.)
6. **Product photos** for all items (none in the sheet), plus logo SVG, hero video, about-page photos.
7. Weight (grams) per variant, needed for shipping.
8. Domain name (artq.in / artq.com?) and business email.
9. Pigment colour hex codes (for swatches), or should we sample them from photos?
10. Who will receive admin emails/notifications? WhatsApp business number?
