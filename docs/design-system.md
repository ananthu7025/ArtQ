# ArtQ: Design System

Derived from the reference prototype's CSS (`qcraft-nine.vercel.app`) and the mobile screenshot `ArtQ Site Ref.png`.
Implemented as **Tailwind CSS theme tokens + CSS variables** in `packages/ui`, shared by storefront and admin.

---

## 1. Brand personality
Calm, crafted and premium but approachable. Teal "resin" colour on clean white/slate surfaces, a serif display face for
elegance, and natural product photography (wood, resin pours). Lots of whitespace, rounded imagery, no harsh shadows.

## 2. Colour tokens

### 2.1 Core palette (from the reference CSS variables)

| Token | Hex | Reference var | Usage |
|-------|-----|---------------|-------|
| `brand-500` | `#00a99d` | `--maroon` | Primary buttons, links, active states, prices badges |
| `brand-400` | `#00c4c7` | `--maroon-light` | Hover/light accents, gradient middle |
| `brand-700` | `#007f7a` | `--maroon-dark` | Button hover/pressed, text on light brand bg |
| `accent-500` | `#009bc2` | `--accent` | Secondary accents, gradient start, info |
| `gradient-brand` | `linear-gradient(135deg,#009bc2,#00c4c7,#00a99d)` | `--gradient-brand` | Announcement bar, hero CTA, logo plate |
| `surface-0` | `#ffffff` | `--pink-light` | Cards, header |
| `surface-50` | `#f8fafc` | `--pink-bg` | Page background (alternating sections) |
| `surface-100` | `#f1f5f9` | `--cream` | Section backgrounds, input bg |
| `surface-200` | `#e2e8f0` | `--cream-dark`, `--border` | Borders, dividers |
| `slate-400` | `#94a3b8` | `--beige` | Placeholder text, disabled |
| `ink-900` | `#111827` | `--text-dark`, `--dark-bg` | Headings, footer background |
| `ink-700` | `#374151` | `--text-mid` | Body text |
| `ink-500` | `#64748b` | `--text-light` | Secondary text, captions |
| `warm-white` | `#fffaf4` | `--white` | Text on dark footer, hero overlay text |

> The reference names its vars "maroon/pink/cream" (left over from a template) but the values are teal/slate. Use the semantic names above.

### 2.2 Feedback colours
| Token | Hex | Usage |
|-------|-----|-------|
| `success` | `#16a34a` | In stock, success toasts, savings text |
| `warning` | `#d97706` | Low stock, pending |
| `danger` | `#dc2626` | Errors, out of stock, cancel |
| `star` | `#f5b301` | Rating stars |
| `sale` | `#e11d48` | Optional "-25 %" badge (or use brand) |

### 2.3 Rules
- Body text `ink-700` on `surface-0` = contrast 10.3:1 ✓. `brand-500` on white = 3.0:1, so use it **only for large text / icons / button backgrounds with white bold text ≥ 16 px**. For small teal text links use `brand-700` (4.9:1 ✓).
- Footer: `ink-900` background, `warm-white` headings, `#cbd5e1` links, `brand-400` hover.
- Overlays (drawers/modals): `rgba(17,24,39,0.5)`.
- Shadows: `--shadow: 0 2px 8px #1118270d`, `--shadow-hover: 0 8px 24px #1118271a`.

## 3. Typography

Fonts (Google Fonts, `display=swap`, self-hosted via `next/font` for performance):

| Role | Family | Weights | Fallback |
|------|--------|---------|----------|
| Display / headings | **Playfair Display** | 400, 500, 600, 700, 400 italic | Georgia, serif |
| Eyebrows / logo subtitle / nav | **Tenor Sans** | 400 | Inter, sans-serif |
| Body / UI | **Inter** | 300, 400, 500, 600 | system-ui, -apple-system, Segoe UI, Roboto, sans-serif |

### 3.1 Type scale (mobile → desktop)

| Token | Mobile | Desktop | Line height | Font | Usage |
|-------|--------|---------|-------------|------|-------|
| `display` | 44px | 88px | 1.0 | Playfair 600, tracking 0.08em | Hero "ARTQ" |
| `h1` | 26px | 36px | 1.2 | Playfair 600 | Page titles, PDP name |
| `h2` | 22px | 30px | 1.25 | Playfair 600 | Section titles ("Product Category") |
| `h3` | 18px | 22px | 1.3 | Playfair 500 | Card group titles |
| `eyebrow` | 13px | 14px | 1.4 | Inter 600 uppercase, tracking 0.12em | "CHECK OUT OUR RANGE" |
| `subtitle` | 15px | 17px | 1.4 | Tenor Sans uppercase tracking 0.3em | "WOOD MOULDS & RESINS" |
| `body-lg` | 16px | 17px | 1.6 | Inter 400 | Descriptions |
| `body` | 14px | 15px | 1.55 | Inter 400 | Default |
| `small` | 12px | 13px | 1.45 | Inter 400 | Captions, badges, footer bottom line |
| `price` | 16px | 18px | 1.2 | Inter 600 | Card price |
| `price-lg` | 24px | 28px | 1.2 | Inter 700 | PDP price |
| `button` | 14px | 14px | 1 | Inter 600 uppercase tracking 0.06em | Buttons |

## 4. Spacing, radius, layout

- **Spacing scale (px):** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96.
- **Section vertical padding:** 40 px mobile / 72 px desktop.
- **Container:** max-width 1320 px, side padding 16 px (mobile) / 24 px (tablet) / 32 px (desktop).
- **Radius:** `sm` 6px (inputs, chips), `md` 10px (buttons-rect), `lg` 16px (product images, cards), `xl` 24px (reel cards, modals), `full` (pills, avatars, category circles).
- **Breakpoints:** `sm` 480, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1440.
- **Grid gap:** 12 px mobile, 20 px desktop (reference `--grid-gap`).
- **Product grid columns:** 2 / 3 (≥768) / 4 (≥1024) / 5 (≥1440) (reference `--cols`).
- **Z-index scale:** header 40, dropdown 45, drawer-overlay 50, drawer 55, modal 60, toast 70.

## 5. Components

### 5.1 Section title (signature element)
```
          CHECK OUT OUR RANGE              ← eyebrow, ink-900, centred
──────────  Product Category  ──────────   ← h2 Playfair; lines 1.5px brand-500, flex-1 each side, 16px gap
      Explore our newly launched products  ← optional subtitle, Inter 500 ink-900
```
Markup: `<div class="flex items-center gap-4"><span class="h-px flex-1 bg-brand-500"/><h2/>…</div>`.

### 5.2 Buttons
| Variant | Style | Usage |
|---------|-------|-------|
| `primary` | bg `brand-500`, text white, radius `md`, height 48 (mobile) / 44, hover `brand-700`, focus ring 3 px `brand-400/40` | Add to cart, Place order |
| `pill-add` | bg `brand-500`, white, radius full, height 32, font 13/600 | Card "ADD" (reference) |
| `secondary` | border 1.5 px `ink-900`, text `ink-900`, transparent bg; hover bg `ink-900` text white | Buy now, View all |
| `ghost` | text `brand-700`, no border | Inline actions |
| `danger` | bg `danger` | Admin delete |
| `icon` | 40×40 round, hover bg `surface-100` | Header icons, wishlist |
States: disabled (opacity .5, cursor not-allowed), loading (spinner replaces label, width fixed).

### 5.3 Inputs
Height 48 px (mobile, avoids iOS zoom: font 16px) / 44 px desktop; border 1px `surface-200`; radius `sm`; focus border `brand-500` + ring; label above (13px/500); error text 12px `danger` below with icon; helper text `ink-500`. Newsletter input in footer: transparent bg, bottom border only, white text, "SUBSCRIBE" text-button in `brand-400`.

### 5.4 Category tile
Circle image 96 px (mobile) / 120 px (desktop), `object-cover`, 1px border `surface-200`; hover: scale 1.04 + ring 2px `brand-500`; label below 14px Inter 500 `ink-900`, max 2 lines.

### 5.5 Product card
- Image: aspect 1:1, radius `lg`, bg `surface-100`, `object-cover`.
- Name: 15px Inter 500 centred, 2-line clamp, margin-top 10px.
- Price: "Rs. 250.00" style in reference → we render `₹250` 16px/600 `ink-900`, MRP strike 13px `ink-500`.
- ADD pill centred below (reference); on desktop hover a ♡ appears top-right.
- Card has no border/shadow by default; hover lifts image (`--shadow-hover`, translateY(-2px)).

### 5.6 Reel card
Aspect 9:16, radius `xl`, video cover; bottom overlay: dark gradient, product row (36px thumb radius 8, name 13px white, price 13px/600 white). Play icon when paused.

### 5.7 Testimonial card
White card, radius `lg`, padding 24px, quote 15px italic centred in quotes, 5 stars 18px `star`, name 13px `ink-500`; arrows 36px icon buttons outside card.

### 5.8 Badges / chips
- Badge: 11px/600 uppercase, padding 4×8, radius `sm`. NEW = `ink-900` bg white text; Discount = `brand-500` bg; Out of stock = `surface-200` bg `ink-700`.
- Header count badge: 16px circle `ink-900` (reference shows black) with white 10px number, top-right of icon.
- Filter chip: border 1px `surface-200`, radius full, 13px; selected bg `brand-500` white text.
- Order status pill colours: PENDING_PAYMENT grey, PLACED blue, CONFIRMED indigo, PACKED purple, SHIPPED amber, OUT_FOR_DELIVERY orange, DELIVERED green, CANCELLED/EXPIRED red, RETURN_* pink.

### 5.9 Variant selector
Pill buttons min-width 64px, height 40px, border 1.5px `surface-200`, selected border `brand-500` + bg `brand-500/8` + text `brand-700` 600; unavailable: diagonal strike line + text `slate-400`. Colour swatch 32px circle with 2px white inner ring, selected outer ring `brand-500`.

### 5.10 Drawers, modals, toasts
- Drawer width: 85vw (max 380px) mobile menu (left); 420px cart (right, full width on mobile); bottom sheet for filters/quick-add (max-height 85vh, drag handle, radius top `xl`).
- Modal: max-width 560px, radius `xl`, padding 24px, close × top-right; Esc closes; focus trapped.
- Toast: `ink-900` bg, white text, radius `md`, auto-hide 3s, with optional action ("Undo", "View cart").

### 5.11 Skeletons
`surface-100` blocks with shimmer gradient animation 1.2s, matching component dimensions.

### 5.12 Icons
**lucide-react** (same as reference), 20px default / 22px header, stroke 1.75. Menu, Search, User, Heart, ShoppingBag, ChevronLeft/Right, X, Plus, Minus, Truck, ShieldCheck, RotateCcw, BadgeCheck, MessageCircle (WhatsApp uses brand SVG).

## 6. Page layouts (wireframes)

### 6.1 Home (mobile, matches reference screenshot)
```
┌──────────────────────────────┐
│ ▸ Shipping all over India • Free shipping orders above 1000 ▸ │ announcement (gradient, 32px)
├──────────────────────────────┤
│ ☰ 🔍        [ARTQ]      👤 ♡⁰ 🛒⁰ │ header 60px, sticky
├──────────────────────────────┤
│                              │
│      A R T Q                 │ hero video 60vh
│   WOOD MOULDS & RESINS       │
├──────────────────────────────┤
│     CHECK OUT OUR RANGE      │
│ ─── Product Category ───     │
│  (○)      (○)      (○)       │ 3-col circles
│ Resins  Wooden   Multiwood   │
│  (○)      (○)      (○)       │
│ Hoops  Silica Gel Pigments   │
│  (○)      (○)      (○)       │
│Glitters UV Resin  More..     │
├──────────────────────────────┤
│ ───── New Arrivals ─────     │
│ Explore our newly launched…  │
│ [img]        [img]           │ 2-col cards
│ UV Resin     Silica Gel      │
│ ₹250         ₹310            │
│ (ADD)        (ADD)           │
├──────────────────────────────┤
│ ───── Trending now ─────     │
│ [reel 9:16]  [reel 9:16]     │
├──────────────────────────────┤
│ ── Stories with our product ─│
│ ‹ "Absolutely loved…" ★★★★★ › │
├──────────────────────────────┤
│ SUBSCRIBE TO OUR NEWSLETTER  │ dark footer
│ Enter your email   SUBSCRIBE │
│         [logo]               │
│  tagline                     │
│ TYPE   CONNECT   POLICIES    │ 3 columns even on mobile (reference)
│ © 2026 ART Q · powered by…   │
└──────────────────────────────┘
```

### 6.2 Desktop home
Header becomes one row: logo left, nav centre, icons right. Category tiles in one row of 9. New arrivals 5 columns. Reels 4 columns. Testimonials show 3 cards at once. Footer: newsletter band full width, then 4 columns (logo+tagline | TYPE | CONNECT | POLICIES).

### 6.3 PDP desktop
```
Home › Pigments › Gel Pigments
┌───────┬──────────────────────┬────────────────────────────┐
│ thumb │                      │ Metallic Gold Pigment      │
│ thumb │      MAIN IMAGE      │ ₹90  ~~₹120~~  25% OFF     │
│ thumb │        1:1           │ Inclusive of all taxes     │
│       │                      │ Size: [20 gm]              │
│       │                      │ ● In stock                 │
│       │                      │ [– 1 +] [ADD TO CART] [♡]  │
│       │                      │ [        BUY NOW        ]  │
│       │                      │ Pincode [_____] Check      │
│       │                      │ 🚚 Free > ₹1000 🔒 Secure  │
│       │                      │ ▸ Description              │
│       │                      │ ▸ Product details          │
│       │                      │ ▸ Specifications & care    │
└───────┴──────────────────────┴────────────────────────────┘
Frequently bought together · You may also like · Recently viewed
```

### 6.4 Listing desktop
Left sidebar 260px filters (sticky), right grid 4 cols; toolbar above grid: count left, sort right; chips row for active filters.

### 6.5 Admin
Sidebar 248px (`ink-900` bg, white text, active item `brand-500` left border), content max-width 1400px on `surface-50`; cards white radius `lg`; tables with sticky header, 48px rows, zebra none, hover `surface-50`. Uses same tokens; component library **shadcn/ui** themed with these tokens.

## 7. Motion
- Durations: 150ms (hover), 250ms (drawers/modals), 400ms (section fade-in).
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Section fade-up on first view (opacity 0→1, translateY 16→0), once.
- Respect `prefers-reduced-motion: reduce` (disable marquee, autoplay video poster only, no fade).

## 8. Imagery guidelines (for the photographer / client)
- Product images: **square 1:1, at least 1600×1600px**, pure white or light-wood background, product centred filling ~80 %.
- Minimum 3 images per product: front, detail/texture, in-use/lifestyle (resin pour, framed artwork).
- Pigments: one jar shot + one colour swatch shot (poured in clear resin).
- Category tiles: square crops that read well inside a circle.
- Reels: 1080×1920, 10–30 s, MP4 H.264, < 8 MB, with a first-frame thumbnail.
- Hero video: 1920×1080 (desktop) + 1080×1350 (mobile crop), 8–15 s loop, no audio, < 4 MB.
- File naming before upload: `{sku}-{n}.jpg`, e.g. `RES-21-300G-1.jpg`.
