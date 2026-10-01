# ArtQ: Product Catalogue (cleaned)

> Source: `ArtQ_Product_Import_All_Items.xlsx`. The workbook has 3 sheets:
> 1. **"1. Instructions & Image Guide"**: import rules (images, variants, weight in kg, `|` separated bullets).
> 2. **"2. Products & Variants"**: older data in the official import template (has SKUs, weights for some, techniques, resin up to 30 kg).
> 3. **"Sheet1"**: **latest & most complete product list from the client** (more products, stock counts, MRPs). **This document is based on Sheet1**, enriched with SKUs/techniques from sheet 2.
>
> Prices in ₹ (stored as paise in DB). ⚠ = data issue to confirm with the client (full list in §4).
>
> **Publication policy (product.md §8.7):** every product below is imported as a **DRAFT**. Nothing in this sheet is sellable as-is,
> because **no product has an image, a measured weight, approved tax data or a confirmed physical count**. Ambiguous values are
> imported with data flags and safe placeholders, never as sellable data: stock text such as "500KG", "Stock Out" or "min 20" is
> flagged `STOCK_AMBIGUOUS`; copied descriptions are flagged `DESCRIPTION_SUSPECT_COPY`; 10 gm/20 gm conflicts are flagged `SIZE_CONFLICT`;
> guessed weights are imported as `ESTIMATED`; missing prices are flagged `PRICE_MISSING`. Readiness per product is in §6.
> HSN/GST values shown as "⚠ accountant" are placeholders: GST rates were restructured from 22 September 2025, so all rates come from the accountant (D-1).

---

## 1. Catalogue structure (Types → Categories)

| # | Type (homepage tile) | Slug | Categories (slug) | Sheet1 name |
|---|----------------------|------|-------------------|-------------|
| 1 | **Resins** | `resins` | 2:1 Epoxy Resin (`2-1-epoxy-resin`) · 3:1 Epoxy Resin (`3-1-epoxy-resin`) · UV Resin (`uv-resin`) | Epoxy Resin |
| 2 | **Wooden Frames** | `wooden-frames` | Teakwood Frames (`teakwood-frames`) · Round Mahogany Frames (`round-mahogany-frames`) | Teakwood Wood Frames; Hoops or Round Frames → Round Mahagony Frames |
| 3 | **Multiwood Frames** | `multiwood-frames` | Pregnant Mom Frames · Butterfly Frames · Cloud Frames · Couple Frames | Multiwood Frames |
| 4 | **Hoops** | `hoops` | Round Hoops (`round-hoops`) | Hoops or Round Frames |
| 5 | **Pigments** | `pigments` | Gel Pigments (`gel-pigments`) · Mica Powder Pigments (`mica-powder-pigments`) · Pigment Kits (`pigment-kits`) | Pigments |
| 6 | **Glitters** | `glitters` | Glitters (`glitters-all`) | Glitters |
| 7 | **Silica Gel** | `silica-gel` | Silica Gel (`silica-gel-all`) | Silica Gel |
| 8 | **Resin Art Essentials** | `resin-art-essentials` | Tools (`resin-tools`) · Stands (`stands`) | Resin Art Essentials |

Homepage tiles (reference order): Resins · Wooden Frames · Multiwood Frames · Hoops · Silica Gel · Pigments · Glitters · **UV Resin** (tile links to category `/category/uv-resin`) · **More..** (→ `/shop`).
Admin can add a "link override" on a tile, so a tile can point to a category instead of a type.

### Techniques (cross-cutting tags; reference "occasions")
| Technique | Slug | Applied to |
|-----------|------|-----------|
| Resin Art | `resin-art` | All resins, pigments, glitters, frames, essentials |
| Flower / Memory Preservation | `flower-preservation` | Teak frames, double frames, silica gel, resins |
| Photo Framing | `photo-framing` | Teak & mahogany frames |
| Jewellery Making | `jewellery-making` | UV resin, mica, glitters, UV light |
| Table Tops & Coasters | `table-tops-coasters` | 2:1 & 3:1 resin, pigments |
| Deep Pour Casting | `deep-pour-casting` | 2:1 resin (large packs) |
| Home Decor | `home-decor` | Multiwood frames, hoops |
| Embroidery & Hoop Art | `embroidery-hoop-art` | Hoops |

### SKU scheme
`{TYPE}-{CATEGORY}-{OPTION}` uppercase, max 32 chars, e.g. `RES-21-750G`, `TWF-1IN-12X16-DF`, `PIG-GEL-MGOLD`. Sizes: `300 gm` → `300G`, `1.5 kg` → `1.5KG`, `12X16 Double Frame` → `12X16-DF`, `8 Inch Hexagon` → `HEX8`.

### Size normalisation (display labels)
`300 gm`, `750 gm`, `1.5 kg`, `20 gm`, `10 gm`, `500 gm`, `4×6 in`, `12×16 in`, `8 in`, `6 in`. Spreadsheet values like `500GM`, `20gm`, `10`, `6Inch`, `8 inch`, `4X6` are normalised on import.

---

## 2. Products & variants

### 2.1 Resins

**P1. ArtQ Ultra Clear 2:1 Epoxy Resin**: `/product/2-1-epoxy-resin`: category 2:1 Epoxy Resin
- Description: Crystal clear 2:1 epoxy resin. Smooth and easy to mix. Ideal for resin art, casting and coating projects. Bubble-free, yellow-resistant, self-levelling.
- Details: Crystal clear finish · Easy to mix · Low odour · Suitable for resin art and craft projects
- Care/usage: Mix resin and hardener in a 2:1 ratio · Mix thoroughly before use · Work in a clean and dust-free area · Store in a cool dry place · Keep container tightly closed · Avoid direct sunlight and heat · Keep away from children
- Techniques: Resin Art, Table Tops & Coasters, Deep Pour Casting, Flower Preservation · HSN/GST: ⚠ accountant (D-1)

| SKU | Size | Price | MRP | Stock |
|-----|------|------:|----:|------:|
| RES-21-300G | 300 gm | 499 | n/a | ⚠ "500KG" |
| RES-21-750G | 750 gm | 849 | n/a | ⚠ blank |
| RES-21-1.5KG | 1.5 kg | 1,499 | n/a | ⚠ |
| RES-21-3KG | 3 kg | 2,850 | n/a | ⚠ |
| RES-21-6KG | 6 kg | 5,450 | n/a | ⚠ |
| *(sheet 2 only)* RES-21-9KG … 30KG | 9/12/15/18/21/24/27/30 kg | 8,050 / 10,600 / 13,100 / 15,550 / 17,950 / 20,300 / 22,600 / 24,850 | n/a | ⚠ confirm if sold online |

**P2. ArtQ 3:1 Epoxy Resin**: `/product/3-1-epoxy-resin`
- Description: Crystal clear 3:1 epoxy resin. Smooth and easy to mix. Ideal for resin art, casting and coating projects.
- Details: Crystal clear finish · Smooth and easy to mix · Suitable for resin art and craft projects · Ideal for casting and coating
- Care: Mix resin and hardener in a 3:1 ratio · (same care list as P1)

| SKU | Size | Price | Stock |
|-----|------|------:|------:|
| RES-31-400G | 400 gm | 599 | 0 ("Stock Out") |
| RES-31-1KG | 1 kg | 1,099 | ⚠ |
| RES-31-4KG | 4 kg | 3,799 | ⚠ |

**P3. ArtQ UV Resin**: `/product/uv-resin`
- Description: Crystal clear UV resin. Ready to use and fast curing. Ideal for small resin art, jewellery and craft projects.
- Details: Crystal clear finish · Ready to use · Fast curing under UV light · Ideal for small resin art and craft projects
- Care: Ready to use without mixing · Cure under UV light as recommended · Avoid prolonged exposure to sunlight before curing · Store in a cool dry place · Keep container tightly closed · Keep away from children · Avoid contact with skin and eyes
- Techniques: Jewellery Making, Resin Art

| SKU | Size | Price | Stock |
|-----|------|------:|------:|
| RES-UV-50G | 50 gm | 180 ⚠ (sheet 2: 170; reference site: 250) | 10 |
| RES-UV-100G | 100 gm | 310 | 10 |

### 2.2 Wooden Frames

**Recommended modelling:** the sheet splits teak frames by depth (1 inch / 0.5 inch) as two sub-categories. On the website it is
clearer to have **three products** (Frame, Double Frame, Hexagon Frame) where **depth is the `thickness` option** and size is the `size` option.
The customer picks *Size* + *Depth* on one page. (The import still accepts the sheet as-is; this is the target shape.)

Common copy: *Teak wood frames with plywood base, suitable for photo framing, resin art, preservation projects and decorative artwork.*
Details: Teak wood frame · Plywood base · Smooth finished frame · Suitable for resin art and photo projects.
Care: Keep away from prolonged moisture · Clean with a soft dry cloth · Store in a dry place.
Colour: Natural Teak · Techniques: Photo Framing, Resin Art, Flower Preservation · HSN/GST: ⚠ accountant (D-1)
Stock: client note "All stock available. Pls put min 20 count stock" is an instruction, not a count → `STOCK_AMBIGUOUS`, imported with on hand 0 and **uncounted**; a physical count is required before publishing.

**P4. Teak Wood Frame with Plywood Base**: `/product/teak-wood-frame`

| SKU | Size | Depth | Price |
|-----|------|-------|------:|
| TWF-1IN-4X6 | 4×6 | 1 inch | 210 |
| TWF-1IN-6X6 | 6×6 | 1 inch | 299 |
| TWF-1IN-8X8 | 8×8 | 1 inch | 360 |
| TWF-1IN-10X10 | 10×10 | 1 inch | 399 |
| TWF-1IN-9X12 | 9×12 | 1 inch | 470 |
| TWF-1IN-12X12 | 12×12 | 1 inch | 500 |
| TWF-1IN-12X16 | 12×16 | 1 inch | 640 |
| TWF-1IN-14X14 | 14×14 | 1 inch | 680 |
| TWF-05IN-4X6 | 4×6 | 0.5 inch | 190 |
| TWF-05IN-6X6 | 6×6 | 0.5 inch | 270 |
| TWF-05IN-8X8 | 8×8 | 0.5 inch | 350 |
| TWF-05IN-8X10 | 8×10 | 0.5 inch | 399 ⚠ (more than 10×10 at 380) |
| TWF-05IN-10X10 | 10×10 | 0.5 inch | 380 |
| TWF-05IN-9X12 | 9×12 | 0.5 inch | 460 |

**P5. Teak Wood Double Frame (Plywood Base)**: `/product/teak-wood-double-frame`, for pressed-flower/two-sided preservation

| SKU | Size | Depth | Price |
|-----|------|-------|------:|
| TWF-1IN-9X12-DF | 9×12 | 1 inch | 630 |
| TWF-1IN-12X12-DF | 12×12 | 1 inch | 680 |
| TWF-1IN-12X16-DF | 12×16 | 1 inch | 890 |
| TWF-05IN-9X12-DF | 9×12 | 0.5 inch | 640 ⚠ (more than the 1 inch version at 630) |
| TWF-05IN-12X16-DF | 12×16 | 0.5 inch | 890 |

**P6. Teak Wood Hexagon Frame**: `/product/teak-wood-hexagon-frame`

| SKU | Size | Depth | Price |
|-----|------|-------|------:|
| TWF-1IN-HEX8 | 8 inch | 1 inch | 480 |
| TWF-1IN-HEX10 | 10 inch | 1 inch | 599 |

**P7. Round Mahogany Frame with Acrylic Base**: `/product/round-mahogany-frame`: category Round Mahogany Frames
- Description: Mahogany wood frames with acrylic base for art, photo framing, resin art and decorative projects.
- Details: Premium quality · Suitable for art and craft projects · Care: Store in a dry place · Handle carefully
- Colour: Natural Mahogany · ⚠ Meta title says "Plywood Base" but product is "Acrylic Base"

| SKU | Size | Price | Stock |
|-----|------|------:|------:|
| MHF-RND-6IN | 6 inch | 399 | 13 |
| MHF-RND-8IN | 8 inch | 499 | 3 |
| MHF-RND-10IN | 10 inch | 599 | 4 |

*(Sheet 2 also had "Mahagani Frames with Plywood Base" 8×8 ₹310, 9×12 ₹410. These are not in Sheet1 ⚠ confirm if discontinued.)*

### 2.3 Multiwood Frames
Common: *Multiwood decorative frames in creative shapes, designed for art, craft and home decor projects.* · Details: Premium quality · Suitable for art and craft projects · Care: Store in a dry place · Handle carefully · Techniques: Home Decor, Resin Art, Flower Preservation.

| Product (slug) | SKU | Size | Colour | Price | Stock |
|----------------|-----|------|--------|------:|------:|
| **P8. Pregnant Mom Frame** (`pregnant-mom-frame`) | MW-MOM-11X6 | 11×6 | White ⚠ | 550 | 7 |
| | MW-MOM-18X10 | 18×10 | White | 850 | 12 |
| **P9. Butterfly Frame** (`butterfly-frame`) | MW-BFLY-10X13.5 | 10×13.5 | n/a | 890 | 7 |
| | MW-BFLY-13X17 | 13×17 | n/a | 990 | 3 |
| **P10. Cloud Frame** (`cloud-frame`) | MW-CLOUD-11X6 | 11×6 | n/a | 690 | 9 |
| | MW-CLOUD-17X10 | 17×10 | n/a | 990 | 9 |
| | MW-CLOUD-20X12 | 20×12 | n/a | 1,199 | 12 |
| **P11. Couple Frame** (`couple-frame`) | MW-COUPLE-11X6 | 11×6 | n/a | 550 | 2 |

### 2.4 Hoops

**P12. Hoop with Acrylic Base**: `/product/hoop-with-acrylic-base`
- Description: Embroidery hoop with decorative wooden finish, suitable for embroidery, needlework and textile art. ⚠ (Name says acrylic base; confirm copy)
- Techniques: Embroidery & Hoop Art, Resin Art, Home Decor

| SKU | Size | Price | Stock |
|-----|------|------:|------:|
| HOOP-ACR-8IN | 8 inch | 330 | 0 (shows "Notify me") |
| HOOP-ACR-10IN | 10 inch | 410 | 10 |

### 2.5 Pigments

**Gel Pigments**: 29 products, each **20 gm · ₹90 · MRP ₹120 (25 % off) · stock 20**
Description pattern: *"{Colour}, premium quality pigment with a rich metallic finish"* (metallic) / *"…with a smooth finish"* (others).
Details: {Colour} · Net Weight 20 gm · Rich metallic finish (metallic only) · Smooth and easy to mix · Premium quality.
Care: Suitable for resin art and craft projects · Easy to mix with resin · Store in a dry place · Keep container tightly closed · Handle carefully.
Techniques: Resin Art, Table Tops & Coasters · HSN/GST: ⚠ accountant (D-1).

| # | Product name (cleaned) | Sheet name | SKU | Slug | Suggested swatch hex ⚠ |
|---|------------------------|-----------|-----|------|-------------|
| 1 | Metallic White Gel Pigment | Metalic White | PIG-GEL-MWHITE | `metallic-white-gel-pigment` | #f4f4f2 |
| 2 | Metallic Silver Gel Pigment | Metalic Silver | PIG-GEL-MSILVER | `metallic-silver-gel-pigment` | #c0c0c0 |
| 3 | Metallic Summer Blue Gel Pigment | Metalic Summer Blue | PIG-GEL-MSUMBLUE | `metallic-summer-blue-gel-pigment` | #3fa9f5 |
| 4 | Metallic Black Gel Pigment | Metalic Black | PIG-GEL-MBLACK | `metallic-black-gel-pigment` | #1f1f1f |
| 5 | Metallic Lemon Yellow Gel Pigment | Metalic Lemon Yellow | PIG-GEL-MLEMON | `metallic-lemon-yellow-gel-pigment` | #f4e04d |
| 6 | Metallic Bronze Gel Pigment | Metalic Bronze | PIG-GEL-MBRONZE | `metallic-bronze-gel-pigment` | #b0703c |
| 7 | Metallic Purple Gel Pigment | Metalic Purple | PIG-GEL-MPURPLE | `metallic-purple-gel-pigment` | #7b3fa0 |
| 8 | Metallic Gold Gel Pigment | Metalic Gold | PIG-GEL-MGOLD | `metallic-gold-gel-pigment` | #d4af37 |
| 9 | Metallic Pink Gel Pigment | Metalic Pink | PIG-GEL-MPINK | `metallic-pink-gel-pigment` | #e46fa8 |
| 10 | Metallic Mint Green Gel Pigment | Metalic Mint Green | PIG-GEL-MMINT | `metallic-mint-green-gel-pigment` | #6fd6b0 |
| 11 | Metallic Red Wine Gel Pigment | Metalic Red Wine | PIG-GEL-MREDWINE | `metallic-red-wine-gel-pigment` | #7b1e3a |
| 12 | Milk White Gel Pigment | Milk White | PIG-GEL-MILKWHITE | `milk-white-gel-pigment` | #fbfbf8 |
| 13 | Matte Orange Gel Pigment | Matte Orange | PIG-GEL-ORANGE | `matte-orange-gel-pigment` | #f07c28 |
| 14 | Pastel Red Gel Pigment | Pastel Red | PIG-GEL-PRED | `pastel-red-gel-pigment` | #f08080 |
| 15 | Myrtle Green Gel Pigment | Myrtle Green | PIG-GEL-MYRTLE | `myrtle-green-gel-pigment` | #317873 |
| 16 | Matte Grey Gel Pigment | Matte Grey | PIG-GEL-GREY | `matte-grey-gel-pigment` | #8a8d91 |
| 17 | Pastel Green Gel Pigment | Pastel Green | PIG-GEL-PGREEN | `pastel-green-gel-pigment` | #a8e6a1 |
| 18 | Matte Yellow Gel Pigment | Matte Yellow | PIG-GEL-YELLOW | `matte-yellow-gel-pigment` | #f6c915 |
| 19 | Midnight Blue Gel Pigment | Midnight Blue | PIG-GEL-MIDNIGHT | `midnight-blue-gel-pigment` | #191970 |
| 20 | Antique Brown Gel Pigment | Antique Brown | PIG-GEL-ABROWN | `antique-brown-gel-pigment` | #6b4423 |
| 21 | Sandstone Gel Pigment | Sandstone | PIG-GEL-SANDSTONE | `sandstone-gel-pigment` | #c2a477 |
| 22 | Aquamarine Gel Pigment | Aqua Marine | PIG-GEL-AQUA | `aquamarine-gel-pigment` | #3fd0c9 |
| 23 | Emerald Green Gel Pigment | Emarald Green | PIG-GEL-EMERALD | `emerald-green-gel-pigment` | #0f8a5f |
| 24 | Pastel Pink Gel Pigment | Pastel Pink | PIG-GEL-PPINK | `pastel-pink-gel-pigment` | #f7b6c8 |
| 25 | Ultramarine Blue Gel Pigment | Ultra Marine Blue | PIG-GEL-ULTRAMARINE | `ultramarine-blue-gel-pigment` | #2a3fbf |
| 26 | Ivory Gel Pigment | Ivory | PIG-GEL-IVORY | `ivory-gel-pigment` | #f6f0dc |
| 27 | Olive Green Gel Pigment | Olive Green | PIG-GEL-OLIVE | `olive-green-gel-pigment` | #708238 |
| 28 | Windsor Navy Blue Gel Pigment | Windsor Navy Blue | PIG-GEL-NAVY | `windsor-navy-blue-gel-pigment` | #1f2a5a |
| 29 | Pure Red Gel Pigment | Pure Red | PIG-GEL-RED | `pure-red-gel-pigment` | #d7182a |

*(Sheet 2 also listed Nile Blue, Pure Black, Metallic Parrot Green, Pastel Lavender. These are not in Sheet1 ⚠.)*

**Mica Powder Pigments**: 12 products, **10 gm · ₹60 · MRP ₹100 (40 % off)**
Description pattern: *"{Colour}, ultra-fine metallic mica powder."* · Techniques: Resin Art, Jewellery Making.

| # | Product name | SKU | Stock |
|---|--------------|-----|------:|
| 1 | Mica Powder: Silver | PIG-MICA-SILVER | 20 |
| 2 | Mica Powder: Pearl White | PIG-MICA-PWHITE | ⚠ blank |
| 3 | Mica Powder: Pearl Gold | PIG-MICA-PGOLD | ⚠ |
| 4 | Mica Powder: Pearl Maroon | PIG-MICA-PMAROON | ⚠ |
| 5 | Mica Powder: Pearl Pink | PIG-MICA-PPINK | ⚠ |
| 6 | Mica Powder: Pearl Summer Blue | PIG-MICA-PSUMBLUE | ⚠ |
| 7 | Mica Powder: Pearl Lemon Yellow | PIG-MICA-PLEMON | ⚠ |
| 8 | Mica Powder: Pearl Bronze | PIG-MICA-PBRONZE | ⚠ (description copied from Pearl White) |
| 9 | Mica Powder: Pearl Parrot Green | PIG-MICA-PPARROT | ⚠ |
| 10 | Mica Powder: Pearl Orange | PIG-MICA-PORANGE | ⚠ |
| 11 | Mica Powder: Pearl Navy Blue | PIG-MICA-PNAVY | ⚠ |
| 12 | Mica Powder: Pearl Grey | PIG-MICA-PGREY | ⚠ |

⚠ Sizes written as "10" (no unit) and details say "Net Weight 20GM" while size is 10 gm.

**Pigment Kits**

| Product | SKU | Size | Colours included | Price | MRP | Stock |
|---------|-----|------|------------------|------:|----:|------:|
| **Ocean Theme Pigment Kit** ("Beach pigments") | PIG-KIT-OCEAN | 120 gm | Ivory, Aquamarine Blue, Ultramarine Blue, Nile Blue, Milk White, Translucent Blue (6) | 500 | 540 | ⚠ |
| **Basic Pigments: Pack of 5** | PIG-KIT-BASIC5 | 100 gm | White, Black, Ivory, Red, Green, Pink ⚠ (6 colours listed for a pack of 5) | 410 | 450 | ⚠ |
| **Basic Pigments: Pack of 10** | PIG-KIT-BASIC10 | 200 gm | ⚠ only 6 colours listed | 830 | 900 | ⚠ |

### 2.6 Glitters

| Product | SKU | Size | Price | MRP | Stock |
|---------|-----|------|------:|----:|------:|
| **Rainbow Chunky Glitter** (multi-coloured chunky glitters) | GLT-RAINBOW-CHUNK | Set of 9 colours | 150 ⚠ (reference shows ₹150) | n/a | ⚠ |
| **Rainbow Neon Star Glitter** (star-cut glitter for crafts) | GLT-RAINBOW-STAR | Set of 9 colours | 190 | n/a | ⚠ |

### 2.7 Silica Gel

**P. Magic Silica Gel 500 gm**: `/product/magic-silica-gel-500gm`
- Description: Magic Silica Gel for moisture absorption and preservation of art, craft and stored materials (flower drying).
- Details: Magic Silica Gel · Net weight 500 gm · Moisture absorbing material · Care: Keep container closed when not in use · Keep away from children · Store in a dry place
- SKU SG-MAGIC-500G · ₹320 · MRP ₹400 · stock 20 · weight 0.5 kg (sheet 2) · Techniques: Flower Preservation

### 2.8 Resin Art Essentials

| Product | SKU | Size | Price | Stock | Notes |
|---------|-----|------|------:|------:|-------|
| **UV Curing Light** | ESS-UV-LIGHT | 1 unit | 120 | 5 | n/a |
| **Bubble Buster** | ESS-BUBBLE-50G | 50 gm ⚠ | 170 ⚠ | 8 | ⚠ Description & size/price copied from UV Resin |
| **Deco Marker** | ESS-DECO-MARKER | ⚠ "100GM" | 310 ⚠ | 10 | ⚠ Size/price identical to UV Resin 100 gm, likely copy-paste |
| **Blow Torch** | ESS-BLOW-TORCH | n/a | ⚠ missing | 3 | ⚠ No price/description, so it can't go live |
| **Folding Electroplated Metal Stand** | ESS-STAND-6IN / 8IN / 10IN | 6 in / 8 in / 10 in | 190 / 210 / 280 | 10 each | Name typo "Elcstro" |

---

## 3. Counts

| Type | Products | Variants |
|------|---------:|---------:|
| Resins | 3 | 10 (18 incl. 9–30 kg) |
| Wooden Frames | 4 | 24 |
| Multiwood Frames | 4 | 8 |
| Hoops | 1 | 2 |
| Pigments | 44 | 44 |
| Glitters | 2 | 2 |
| Silica Gel | 1 | 1 |
| Resin Art Essentials | 5 | 7 |
| **Total** | **64** | **98** |

---

## 4. Data issues to resolve before go-live (send to client)

| # | Severity | Issue | Rows (Sheet1) | Proposed fix |
|---|----------|-------|---------------|--------------|
| 1 | 🔴 Blocker | **No product images** anywhere (image columns empty) | all | Client to provide photos (see design-system.md §8); we cannot launch products without at least 1 image |
| 2 | 🔴 Blocker | **Parcel weight missing** for almost all variants (needed for shipping) | all | Client to weigh packed items. Planning estimates (below) are imported as `ESTIMATED` and **block publication** |
| 3 | 🔴 | Stock values not numeric: "500KG", "Stock Out", "All stock available. Pls put min 20 count stock", blanks | 2, 7, 12, 25, 76–91 | Never guessed: imported as on hand 0, `STOCK_AMBIGUOUS`, uncounted; physical count via Inventory import before publishing |
| 4 | 🔴 | Blow Torch has no price/size/description | 96 | Stays draft (`PRICE_MISSING`) until client supplies data |
| 5 | 🟠 | Bubble Buster & Deco Marker have UV Resin's description/size/price | 94, 95 | `DESCRIPTION_SUSPECT_COPY` + `SIZE_CONFLICT`; stays draft until corrected |
| 6 | 🟠 | Price inconsistencies: 0.5" 8×10 (₹399) > 10×10 (₹380); 0.5" 9×12 Double (₹640) > 1" (₹630); UV Resin 50 gm ₹180 vs ₹170 (sheet 2) vs ₹250 (reference site) | 28, 31, 10 | Confirm |
| 7 | 🟠 | Resin 9–30 kg packs only in old sheet | n/a | Confirm whether sold online (shipping cost for 30 kg is high) |
| 8 | 🟠 | Products in old sheet missing from new: Mahogany plywood-base frames, Nile Blue/Pure Black/Parrot Green/Lavender pigments, Embroidery Hoop (no acrylic) | n/a | Confirm discontinued |
| 9 | 🟡 | Pack of 5 lists 6 colours; Pack of 10 lists only 6 | 88, 89 | Confirm colour lists |
| 10 | 🟡 | Mica sizes "10" with no unit; details say 20 gm | 75–86 | `SIZE_CONFLICT` until the client confirms the net weight (10 gm proposed) |
| 11 | 🟡 | Pearl Bronze description says "Pearl White" | 82 | Fix |
| 12 | 🟡 | Spelling: Metalic→Metallic, Emarald→Emerald, Mahagani/Mahagony→Mahogany, Elcstro→Electroplated, "Teakwood Wood Frames" | many | Fixed in this doc |
| 13 | 🟡 | Mahogany round frame meta title says "Plywood Base" (product is Acrylic Base); Hoop description says "embroidery hoop" for "Hoops with Acrylic base" | 41, 43 | Confirm copy |
| 14 | 🟡 | "Color" for Pregnant Mom frame = White, others blank | 33 | Confirm colour of multiwood frames |
| 15 | 🟡 | No HSN codes / GST rates | all | Accountant to classify against the current GST schedule (rates changed from 22 Sep 2025); candidate HSN headings to check: wooden frames 4414, epoxy resin 3907, pigments 3206/3212, silica gel 2811. Tax approval is a publication check |
| 16 | 🟡 | Glitters: no MRP/stock; "9 Colours" ambiguous (set of 9, or 9 single-colour variants?) | 90, 91 | Confirm |

### Planning weight estimates (⚠ for shipping-cost planning only; imported as `ESTIMATED`, which blocks publication)
| Category | Default weight per unit |
|----------|------------------------|
| Resin | net weight × 1.15 (bottles + box), e.g. 300 gm → 350 g, 6 kg → 6.9 kg |
| Teak frames | 4×6: 250 g · 8×8: 450 g · 12×12: 800 g · 12×16: 1.1 kg · double frames +40 % |
| Multiwood frames | 600 g (small) / 1 kg (large) |
| Hoops / round frames | 250–500 g |
| Pigments | 20 gm gel: 50 g · 10 gm mica: 30 g · kits: 250–400 g |
| Glitters | 150 g |
| Silica gel 500 gm | 550 g |
| Essentials | UV light 100 g · stands 300–500 g · torch 400 g |

---

## 5. Cleaned import file

During Phase 2 (task 2.7), the CATALOG importer (database.md §9) will:
1. Read **Sheet1**, forward-filling blank Type/Subcategory/Product/Description cells from the row above (the sheet only fills them on the first row of a product).
2. Apply the renames in §2 (spelling, product names) and attach data flags for every §4 issue. **No flagged value is silently "fixed" into sellable data.**
3. Generate SKUs where missing (written back to the result file so they stay stable), slugs, normalised sizes, paise prices.
4. Create every product as **DRAFT**. Numeric stock from the sheet is stored as on hand but **uncounted**. Staff confirm counts with an INVENTORY import or recount, which sets `inventory_counted_at`.
5. Output `catalog.cleaned.xlsx` (official template + a "Flags" column) for the client to correct in Excel and re-import. Re-imports update by SKU and never overwrite stock or publication status.

---

## 6. Readiness at import (all products start as DRAFT)

| Group | Products | Blocking checks at import (besides image, measured weight, tax approval and physical count, which block **all** products) |
|-------|---------:|------------------------------------------------------------------------------------------------------------------------|
| 2:1 Epoxy Resin | 1 | `STOCK_AMBIGUOUS` ("500KG"/blank); D-8 decision for 9–30 kg variants (those variants imported inactive) |
| 3:1 Epoxy Resin | 1 | `STOCK_AMBIGUOUS` ("Stock Out"/blank) |
| UV Resin | 1 | Price conflict (₹180 vs ₹170 vs ₹250) → `PRICE_CONFLICT` flag for review |
| Teak frames (frame, double, hexagon) | 3 | `STOCK_AMBIGUOUS` ("min 20"); price anomalies on 0.5" 8×10 and 0.5" 9×12 double → review flag |
| Round mahogany frame | 1 | Meta title mismatch (review) |
| Multiwood frames | 4 | Colour data incomplete (review) |
| Hoop with acrylic base | 1 | Description mismatch (review) |
| Gel pigments | 29 | Colour hex pending (D-11, non-blocking for publication) |
| Mica powders | 12 | `SIZE_CONFLICT` (10 vs 20 gm); stock blank for 11; Pearl Bronze `DESCRIPTION_SUSPECT_COPY` |
| Pigment kits | 3 | Colour lists inconsistent (review); stock blank |
| Glitters | 2 | Stock/MRP blank; "9 Colours" meaning (review) |
| Magic Silica Gel | 1 | Only the universal checks (weight 0.5 kg in old sheet still needs packed-weight confirmation) |
| Bubble Buster, Deco Marker | 2 | `DESCRIPTION_SUSPECT_COPY`, `SIZE_CONFLICT` (copied from UV Resin) |
| Blow Torch | 1 | `PRICE_MISSING`, no description/size |
| UV light, metal stand | 2 | Only the universal checks |

Once the client supplies photos, measured weights, physical counts and accountant-approved tax data, the only remaining blockers are the group-specific flags above. Each is cleared by a corrected re-import or an admin edit, and the readiness panel shows exactly which ones remain.
