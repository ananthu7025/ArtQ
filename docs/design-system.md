# ArtQ: Design System

Derived from the reference prototype's CSS (`qcraft-nine.vercel.app`) and `ArtQ Site Ref.png`, **corrected for WCAG 2.1 AA**.
Implemented as Tailwind tokens + CSS variables in `packages/ui`, shared by storefront and admin.

---

## 1. Brand personality
Calm, crafted, premium but approachable: teal "resin" accents on clean white/slate surfaces, a serif display face, natural product photography, generous whitespace, soft shadows.

## 2. Colour tokens

### 2.1 Brand palette
| Token | Hex | Reference var | Allowed use |
|-------|-----|---------------|-------------|
| `brand-50` | `#e6f4f3` | n/a | Selected chip/pill background, subtle highlights |
| `brand-300` | `#5eead4` | n/a | Text, focus ring and selected state **on dark surfaces** (`ink-900`) |
| `brand-400` | `#00c4c7` | `--maroon-light` | **Decorative only** (gradients, illustrations). Never text, never a white-text background |
| `brand-500` | `#00a99d` | `--maroon` | **Decorative only**: section-title lines, large decorative icons, brand gradient. Contrast vs white is **2.93:1**, so it is never a background for white text and never small text |
| `brand-700` | `#00756f` | *(new)* | **Primary action colour**: primary/pill buttons (white text), links and small teal text on light surfaces, selected admin nav item, focus ring on light surfaces, checked controls |
| `brand-800` | `#005f5a` | *(replaces `--maroon-dark #007f7a`)* | Hover/pressed for primary buttons; announcement bar background |
| `accent-500` | `#009bc2` | `--accent` | Decorative gradient start only |
| `gradient-brand` | `linear-gradient(135deg,#009bc2,#00c4c7,#00a99d)` | `--gradient-brand` | **Decorative** surfaces without text (hero overlay accents, dividers) |
| `gradient-brand-strong` | `linear-gradient(135deg,#00627a,#006d68,#00756f)` | *(new)* | Any gradient surface carrying text (announcement bar option, banners) |

### 2.2 Neutrals & feedback
| Token | Hex | Use |
|-------|-----|-----|
| `surface-0` | `#ffffff` | Cards, header |
| `surface-50` | `#f8fafc` | Page background |
| `surface-100` | `#f1f5f9` | Section/input background |
| `surface-200` | `#e2e8f0` | Decorative dividers only (not input borders) |
| `border-input` | `#64748b` | Input/checkbox/select borders (meets 3:1 for UI boundaries) |
| `ink-900` | `#111827` | Headings, footer & admin sidebar background |
| `ink-700` | `#374151` | Body text |
| `ink-500` | `#64748b` | Secondary text, placeholders |
| `success-700` | `#15803d` | Success text/badges (replaces `#16a34a`, which is 3.30:1) |
| `warning-700` | `#b45309` | Warning text (replaces `#d97706`, which is 3.19:1); `warning-bg #fef3c7` with `#7c2d12` text |
| `danger-700` | `#b91c1c` | Errors, destructive buttons |
| `danger-300` | `#fca5a5` | Errors **on dark surfaces** (`ink-900` footer): message text and invalid-field border |
| `star` | `#f5b301` | Rating stars (decorative; always paired with text "4.6 out of 5") |

### 2.3 Measured contrast (WCAG 2.1: 4.5:1 normal text, 3:1 large text & UI components)
| Pair | Ratio | Result |
|------|------:|--------|
| White on `brand-500` `#00a99d` (reference buttons) | 2.93 | ✗ not allowed |
| White on `brand-700` `#00756f` (primary button) | 5.56 | ✓ |
| White on `brand-800` `#005f5a` (hover, announcement) | 7.54 | ✓ |
| `brand-700` text on white / `surface-50` / `surface-100` | 5.56 / 5.32 / 5.08 | ✓ |
| `brand-800` on `brand-50` (selected chip) | 6.68 | ✓ |
| White on `gradient-brand-strong` stops (`#00627a`, `#006d68`, `#00756f`) | 6.94 / 6.20 / 5.56 | ✓ |
| `ink-700` body on white | 10.31 | ✓ |
| `ink-500` secondary/placeholder on white | 4.76 | ✓ |
| `border-input` `#64748b` on white | 4.76 | ✓ (≥ 3:1) |
| `success-700` / `warning-700` / `danger-700` text on white | 5.02 / 5.02 / 6.47 | ✓ |
| Admin sidebar text `#e5e7eb` / muted `#9ca3af` on `ink-900` | 14.33 / 6.99 | ✓ |
| Admin selected item: white on `brand-700` | 5.56 | ✓; item vs sidebar boundary `brand-700` on `ink-900` 3.19 ✓ |
| Focus ring: `brand-700` on light / `brand-300` on `ink-900` | 5.56 / 11.99 | ✓ |
| `danger-300` error text / invalid border on `ink-900` (footer newsletter) | 9.34 | ✓ |
| White footer text on `ink-900`; newsletter underline `sidebar-muted` on `ink-900` | 17.74 / 6.99 | ✓ |
| `slate-400` `#94a3b8` on white | 2.56 | ✗ decorative only (was used for placeholders in v1 of this doc) |

The contrast table is checked again in CI with an automated test (axe + token unit test) in Phase 0.

## 3. Typography
| Role | Family | Fallback |
|------|--------|----------|
| Display / headings | **Playfair Display** 400–700 (+ italic) | Georgia, serif |
| Eyebrows / logo subtitle / nav | **Tenor Sans** | Inter, sans-serif |
| Body / UI | **Inter** 300–600 | system-ui, sans-serif |

Loaded via `next/font` (storefront) and self-hosted (admin), Latin subset, `display: swap`.

| Token | Mobile | Desktop | Font |
|-------|--------|---------|------|
| `display` | 44 | 88 | Playfair 600, tracking 0.08em |
| `h1` | 26 | 36 | Playfair 600 |
| `h2` | 22 | 30 | Playfair 600 |
| `h3` | 18 | 22 | Playfair 500 |
| `eyebrow` | 13 | 14 | Inter 600 uppercase, tracking 0.12em |
| `subtitle` | 15 | 17 | Tenor Sans uppercase, tracking 0.3em |
| `body-lg` / `body` / `small` | 16 / 14 / 12 | 17 / 15 / 13 | Inter 400 |
| `price` / `price-lg` | 16 / 24 | 18 / 28 | Inter 600 / 700 |
| `button` | 14 | 14 | Inter 600 uppercase, tracking 0.06em |

Inputs use **16 px** text on mobile (prevents iOS zoom).

## 4. Spacing, radius, layout
Spacing scale 4–96 px; section padding 40 px mobile / 72 px desktop; container max 1320 px with 16/24/32 px gutters; radius `sm 6`, `md 10`, `lg 16`, `xl 24`, `full`; breakpoints `sm 480`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1440`; grid gap 12/20 px; product grid 2/3/4/5 columns; z-index header 40, dropdown 45, overlay 50, drawer 55, modal 60, toast 70.

## 5. Components

### 5.1 Section title
Eyebrow (ink-900) → serif `h2` with 1.5 px `brand-500` lines on both sides (decorative, `aria-hidden`) → optional subtitle.

### 5.2 Buttons
| Variant | Style | Use |
|---------|-------|-----|
| `primary` | bg `brand-700`, white text, radius `md`, height 48 (mobile) / 44; hover/pressed `brand-800` | Add to cart, Place order, Save |
| `pill-add` | bg `brand-700`, white 13/600, radius full, height 36 (touch target ≥ 36×36, padded to 44 hit area) | Card "ADD" |
| `secondary` | 1.5 px `ink-900` border, `ink-900` text; hover bg `ink-900` white text | Buy now, View all |
| `ghost` | `brand-700` text | Inline actions |
| `danger` | bg `danger-700`, white | Delete/archive confirmations |
| `icon` | 40×40 (44 hit area), hover `surface-100` | Header, row actions |
States: focus-visible ring 2 px `brand-700` + 2 px offset (on dark: `brand-300`); disabled = `surface-100` bg + `ink-500` text + `aria-disabled` (never only lowered opacity); loading = spinner, width fixed, `aria-busy`.

### 5.3 Inputs
Height 48/44; border 1 px `border-input`; focus 2 px `brand-700`; label above (13/500); error text `danger-700` with icon and `aria-describedby`; helper `ink-500`. Footer newsletter: bottom border `#cbd5e1` on dark, white text, "SUBSCRIBE" in `brand-300`.

### 5.4 Category tile
96/120 px circle image; hover ring 2 px `brand-700`; label 14/500 `ink-900`.

### 5.5 Product card
Image 1:1 radius `lg` on `surface-100` with **fixed aspect box** (no layout shift). If there's no image, show a neutral placeholder with the ArtQ mark. Name 15/500 (2-line clamp); price `ink-900` 16/600, struck MRP `ink-500`; ADD pill; ♡ (`aria-pressed`).

### 5.6 Reel card, testimonial card, badges, chips
- Reel: 9:16 radius `xl`; bottom overlay gradient `rgba(17,24,39,0)` → `rgba(17,24,39,0.85)` so white text reaches ≥ 4.5:1.
- Testimonial: quote 15 italic, stars + visually hidden "Rated 5 out of 5", arrows as buttons with labels.
- Badges: NEW `ink-900`/white; discount `brand-700`/white; out of stock `surface-200`/`ink-700`.
- Filter chip selected: `brand-50` bg, `brand-800` text, 1 px `brand-700` border.
- Order/product status pills (text + colour, never colour alone): Draft (`surface-100`/`ink-700`), Active (`#dcfce7`/`success-700`), Archived (`surface-200`/`ink-700`), Pending payment/Processing (`warning-bg`/`#7c2d12`), Shipped (`#dbeafe`/`#1e40af`), Delivered (`#dcfce7`/`success-700`), Cancelled/Expired (`#fee2e2`/`danger-700`), Exception (`danger-700`/white).

### 5.7 Variant selector
Pills min 64×40, border `border-input`; selected `brand-700` border 2 px + `brand-50` bg + `brand-800` text. **Sold out** (the combination exists): strike-through + `ink-500`, accessible name "Gold, sold out", still selectable because choosing it offers "Notify me". **Not available with the other choices** (no such variant): dashed border + `ink-500`, name "100 gm, other options will change"; choosing it moves the other options to the nearest real combination (in stock first). Neither uses `aria-disabled`: both do something when chosen (task 3.4 refinement). Colour swatch with the colour name in the accessible label.

### 5.8 Drawers, modals, toasts, skeletons
Drawers (mobile menu left 85vw max 380; cart right 420/full), bottom sheets (filters, quick add); modals max 560, focus-trapped, Esc closes, focus returns to trigger; toasts `ink-900`/white, `role="status"`, 5 s (pause on hover); skeleton shimmer disabled under reduced motion.

### 5.9 Icons
lucide-react 20/22 px, stroke 1.75, `aria-hidden` unless standalone (then `aria-label`).

## 6. Layouts

### 6.1 Home (mobile, matches the reference screenshot)
```
┌──────────────────────────────┐
│ Shipping all over India • …  │ announcement (brand-800, white)
├──────────────────────────────┤
│ ☰ 🔍        [ARTQ]   👤 ♡⁰ 🛒⁰ │ header 60px sticky
├──────────────────────────────┤
│   A R T Q / WOOD MOULDS & RESINS │ hero video 60vh
├──────────────────────────────┤
│ CHECK OUT OUR RANGE          │
│ ─── Product Category ───     │
│ (○) Resins (○) Wooden (○) Multiwood │ 3-col circles
│ (○) Hoops (○) Silica Gel (○) Pigments│
│ (○) Glitters (○) UV Resin (○) More.. │
├──────────────────────────────┤
│ ───── New Arrivals ─────     │ 2-col cards, ADD pills (brand-700)
├──────────────────────────────┤
│ ───── Trending now ─────     │ 2-col reels
├──────────────────────────────┤
│ ── Stories with our product ─│ testimonial carousel
├──────────────────────────────┤
│ newsletter · logo · TYPE / CONNECT / POLICIES · ©     │ dark footer
└──────────────────────────────┘
```

### 6.2 Desktop home, PDP, listing
Header single row; categories one row of 9; new arrivals 5 columns; reels 4; testimonials 3. PDP: gallery 55 % / sticky info 45 %. Listing: 260 px sticky filter sidebar + 4-column grid.

### 6.3 Checkout states
"Payment processing" screen: spinner + "We're confirming your payment with your bank. This usually takes under a minute." + order number; after 2 minutes: "We'll email you as soon as it's confirmed" + link to order. Never shows "failed" while status is unknown.

### 6.4 Admin shell
```
┌──────────────┬───────────────────────────────────────────────┐
│ ArtQ Admin   │ Top bar: ☰ (≤1023px) · global search · 🔔 · user │
│──────────────│───────────────────────────────────────────────│
│ Dashboard    │                                               │
│ Orders       │   Page header: title · primary action          │
│ Customers    │   Filters / tabs                              │
│ Coupons      │   Table (sticky header, 48 px rows)           │
│ Shipping Rates│                                              │
│ Products  ◀  │   Pagination: ‹ Previous  Page 3 of 7  Next › │
│ Restock Req. │                                               │
│ Product Types│                                               │
│ Categories   │                                               │
│ Techniques   │                                               │
│ ── Operations│                                               │
│ Inventory …  │  (sidebar scrolls independently ↕)            │
└──────────────┴───────────────────────────────────────────────┘
```
- Sidebar: width 248 px, `ink-900` bg, `position: sticky; top: 0; height: 100dvh; overflow-y: auto; overscroll-behavior: contain`. Group headings `#9ca3af` 11 px uppercase. Items 40 px tall, `#e5e7eb` text, hover `#1f2937`, **selected: `brand-700` background + white text + `aria-current="page"`**, focus ring `brand-300`. Long lists stay reachable at 600 px viewport height and 200 % zoom; the logo/header area is fixed and the item list scrolls.
- < 1024 px: sidebar becomes an off-canvas drawer (☰ in the top bar, focus trap, Esc/overlay closes, returns focus).
- Content: `surface-50` background, white cards radius `lg`, max width 1440.

### 6.5 Admin Products page
```
Products                                    [Import] [Export] [+ Add Product]
[Search name or SKU……]  Status ▾  Stock ▾  Readiness ▾  Image ▾
[All 64] [Resins 3] [Wooden Frames 4] [Multiwood 4] [Hoops 1] [Pigments 44] [More ▾] [Unassigned 0]
☐ | # | Image | Name                       | Type      | Price      | Available | Status            | Variants | Actions
☐ | 1 | [img] | ArtQ 2:1 Epoxy Resin        | Resins    | ₹499–5,450 | 0  ⚠      | Draft  ◯ toggle ⚠ | 5        | ✎ ⋯
☐ | 2 | [⟳ ] | Metallic Gold Gel Pigment   | Pigments  | ₹90        | 20        | Active ● toggle   | 1        | ✎ ⋯
☐ | 3 | [▢ ] | Blow Torch                  | Unassigned| —          | 3         | Draft  ◯ toggle ⚠ | 1        | ✎ ⋯
                                         ‹ Previous   Page 1 of 4   Next ›
```
Image states: ready thumbnail · ⟳ processing (spinner, "Processing") · ⚠ failed (danger icon, "Processing failed, retry") · ▢ missing (placeholder, "No image"). All 48×48 with alt text. Type "Unassigned" uses a neutral outline badge (never "Unknown"). The toggle has an accessible name ("Publish Metallic Gold Gel Pigment") and announces gate failures in a popover/live region.

## 7. Motion
150/250/400 ms; `cubic-bezier(0.22,1,0.36,1)`; fade-up once; everything respects `prefers-reduced-motion`.

## 8. Imagery guidelines (for the client)
Square 1:1 product images ≥ 1600 px on white/light wood; minimum 3 per product (front, detail, in use); pigments: jar + resin swatch; reels 1080×1920 ≤ 8 MB; hero 1920×1080 + 1080×1350, ≤ 4 MB; file names `{sku}-{n}.jpg`. Uploaded images are re-encoded and metadata-stripped.
