# ArtQ: Project Documentation

ArtQ is an Indian D2C e-commerce store selling **wood moulds/frames, epoxy & UV resins, pigments, glitters, silica gel and resin-art essentials**.
These documents are the single source of truth for building the store from scratch. The reference prototype is
https://qcraft-nine.vercel.app/ (see `ArtQ Site Ref.png` for the mobile homepage).

## Read in this order

| # | File | What it answers |
|---|------|-----------------|
| 1 | [product.md](product.md) | **What** we are building: goals, users, every page, every feature, business rules, user flows |
| 2 | [design-system.md](design-system.md) | **How it looks**: colours, fonts, spacing, components, page layouts at every breakpoint |
| 3 | [architecture.md](architecture.md) | **How it is built**: tech stack, system diagram, folder structure, auth, payments, shipping, images, deployment, security |
| 4 | [database.md](database.md) | **What we store**: every table, column, type, constraint, index, relation, plus the full Prisma schema |
| 5 | [api.md](api.md) | **How the frontends talk to the backend**: every endpoint, request/response shape, errors |
| 6 | [catalog.md](catalog.md) | **The actual products**: the cleaned catalogue from `ArtQ_Product_Import_All_Items.xlsx`, slugs, SKUs, data issues to fix |
| 7 | [tasklist.md](tasklist.md) | **In what order**: phases 0–9, every task with acceptance criteria and estimates |

## One-paragraph summary

A **Next.js storefront** (used only for UI and server-rendered SEO pages, with **no backend code in Next.js**) and a **React admin panel**
are both pure clients of a **Node.js + Express REST API**, which is the only backend. The API is backed by **PostgreSQL (via Prisma)**,
**Redis + BullMQ** (background jobs: emails, stock release, reminders, image processing, imports; plus rate limiting and caching)
and **S3-compatible object storage (Cloudflare R2)** for images and videos. Payments go through **Razorpay** (with optional COD). Shipping is **weight-based**, with free shipping above ₹1,000.
Everything lives in one **pnpm + Turborepo monorepo**.

## Glossary

| Term | Meaning |
|------|---------|
| **Type** | Top-level product group shown as round tiles on the homepage, e.g. *Resins*, *Wooden Frames*, *Pigments* |
| **Category** | Sub-group inside a Type, e.g. *2:1 Resin*, *1 inch depth Teakwood Frames*, *Gel Pigments* |
| **Product** | A sellable item with a name, description, images, e.g. *2:1 Epoxy Resin* |
| **Variant** | A specific buyable option of a product with its own price, MRP, stock, SKU, weight, e.g. *2:1 Epoxy Resin – 750 gm* |
| **Technique / Occasion** | Cross-cutting tag such as *Deep Pour Casting*, *Resin Preservation*, *Jewellery*; a product can have many |
| **Collection** | Hand-picked set of products for a campaign (e.g. *Beginner Kit*, *Diwali Gifting*) |
| **Reel** | Short vertical video (Instagram-style) linked to a product, shown in *Trending now* |
| **MRP** | Maximum Retail Price (strike-through price). Selling price ≤ MRP |
| **Paise** | All money is stored as integers in paise (₹1 = 100 paise) to avoid floating-point errors |
