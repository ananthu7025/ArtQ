// GET /v1/home (api.md §3.1, product.md §5.1). Everything the home page shows, in one public, cacheable response.
// Only ACTIVE products and READY public media are ever returned (a draft or a broken file cannot reach the page);
// sections that would be empty are left out of `sections`, so the page never renders an empty heading.
import { DEFAULT_SETTINGS, discountPercent, HOME_SECTION_KEYS, parseSetting, settingSchemas, type HomeHeroSlide, type HomeSectionKey, type HomeView, type MediaRef, type ProductCard, type SettingKey, type SettingValue, type VideoRef } from '@artq/shared';
import { Prisma, type Media, type PrismaClient } from '@prisma/client';

const CARD_LIMIT = 8;
const CONTENT_LIMIT = 12;
/** The rendition used as `url` (cards are at most ~320 CSS px wide, 2× for retina). */
const PREFERRED_WIDTH = 640;

export type MediaUrl = (key: string) => string;

/** READY public image → MediaRef; anything else (processing, rejected, private, deleted, a video) → null. */
export function mediaRef(m: Media | undefined | null, alt: string, url: MediaUrl): MediaRef | null {
  if (!m || m.kind !== 'IMAGE' || m.status !== 'READY' || m.visibility !== 'PUBLIC' || m.deletedAt || !m.width || !m.height) return null;
  const renditions = Object.entries((m.renditions ?? {}) as Record<string, string>).map(([w, key]) => ({ w: Number(w), key })).filter((r) => Number.isFinite(r.w) && r.w > 0).sort((a, b) => a.w - b.w);
  if (renditions.length === 0) return null;
  const main = renditions.find((r) => r.w >= PREFERRED_WIDTH) ?? renditions.at(-1)!;
  return {
    id: m.id, url: url(main.key), width: m.width, height: m.height, alt, placeholder: m.placeholder,
    srcset: { webp: renditions.map((r) => `${url(r.key)} ${r.w}w`).join(', ') },
  };
}

/** READY public video → VideoRef (served as uploaded). */
export function videoRef(m: Media | undefined | null, url: MediaUrl): VideoRef | null {
  if (!m || m.kind !== 'VIDEO' || m.status !== 'READY' || m.visibility !== 'PUBLIC' || m.deletedAt) return null;
  return { id: m.id, url: url(m.key), mime: m.detectedMime ?? m.declaredMime, width: m.width, height: m.height };
}

type CardRow = {
  id: number; slug: string; name: string; min_price: number | null; max_price: number | null; available_qty: number; active_variant_count: number;
  is_new_arrival: boolean; is_trending: boolean; type_slug: string; type_name: string; cheapest_mrp: number | null; single_variant_id: number | null;
};

/** ProductCards for ACTIVE products matching `where` (SQL over `p`), in `order`; images: cover first, then the next one for hover. */
export async function productCards(prisma: PrismaClient, where: Prisma.Sql, order: Prisma.Sql, limit: number, url: MediaUrl): Promise<ProductCard[]> {
  const rows = await prisma.$queryRaw<CardRow[]>`
    SELECT p.id, p.slug, p.name, p.min_price, p.max_price, p.available_qty, p.active_variant_count, p.is_new_arrival, p.is_trending,
           t.slug AS type_slug, t.name AS type_name, cv.mrp AS cheapest_mrp,
           CASE WHEN p.active_variant_count = 1 THEN cv.id END AS single_variant_id
    FROM products p
    JOIN product_types t ON t.id = p.type_id
    LEFT JOIN LATERAL (
      SELECT v.id, v.mrp FROM product_variants v
      WHERE v.product_id = p.id AND v.is_active AND v.deleted_at IS NULL AND v.price IS NOT NULL
      ORDER BY v.price, v.id LIMIT 1
    ) cv ON true
    WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND p.min_price IS NOT NULL AND (${where})
    ORDER BY ${order}
    LIMIT ${limit}`;
  if (rows.length === 0) return [];
  const images = await prisma.productImage.findMany({
    where: { productId: { in: rows.map((r) => r.id) }, media: { status: 'READY', visibility: 'PUBLIC', kind: 'IMAGE', deletedAt: null } },
    include: { media: true }, orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => {
    const own = images.filter((i) => i.productId === r.id);
    const fromPrice = Number(r.min_price);
    const mrp = r.cheapest_mrp === null ? null : Number(r.cheapest_mrp);
    return {
      id: r.id, slug: r.slug, name: r.name,
      image: mediaRef(own[0]?.media, own[0]?.alt ?? r.name, url), hoverImage: mediaRef(own[1]?.media, own[1]?.alt ?? r.name, url),
      fromPrice, maxPrice: Number(r.max_price ?? r.min_price), mrp: mrp !== null && mrp > fromPrice ? mrp : null, discountPercent: discountPercent(fromPrice, mrp),
      inStock: Number(r.available_qty) > 0, isNew: r.is_new_arrival, isTrending: r.is_trending,
      variantCount: Number(r.active_variant_count), defaultVariantId: r.single_variant_id === null ? null : Number(r.single_variant_id),
      type: { slug: r.type_slug, name: r.type_name },
    };
  });
}

export async function setting<K extends SettingKey>(prisma: PrismaClient, key: K): Promise<SettingValue<K>> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const parsed = row?.isPublic ? settingSchemas[key].safeParse(row.value) : null;
  return parsed?.success ? (parsed.data as SettingValue<K>) : parseSetting(key, DEFAULT_SETTINGS[key]);
}

export async function loadHome(prisma: PrismaClient, url: MediaUrl, now = new Date()): Promise<HomeView> {
  const [sectionsSetting, hero, insta, social] = await Promise.all([setting(prisma, 'HOME_SECTIONS'), setting(prisma, 'HERO'), setting(prisma, 'INSTAGRAM_MOMENTS'), setting(prisma, 'SOCIAL')]);
  const activeProduct = { status: 'ACTIVE' as const, deletedAt: null };

  const [slides, types, newArrivals, trending, reels, techniques, testimonials] = await Promise.all([
    prisma.homeSlide.findMany({
      where: { isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
      include: { media: true, mobileMedia: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 5,
    }),
    prisma.productType.findMany({ where: { isActive: true, showOnHome: true }, include: { image: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    // Flagged new arrivals by rank, then the most recently published to fill the row.
    productCards(prisma, Prisma.sql`true`, Prisma.sql`p.is_new_arrival DESC, p.new_arrival_rank ASC NULLS LAST, p.published_at DESC NULLS LAST, p.id DESC`, CARD_LIMIT, url),
    productCards(prisma, Prisma.sql`p.is_trending`, Prisma.sql`p.trending_rank ASC NULLS LAST, p.published_at DESC NULLS LAST, p.id DESC`, CARD_LIMIT, url),
    prisma.reel.findMany({ where: { isActive: true }, include: { video: true, thumbnail: true, product: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: CONTENT_LIMIT }),
    // Only techniques with something to buy, so a tile never leads to an empty page.
    prisma.technique.findMany({ where: { isActive: true, products: { some: { product: activeProduct } } }, include: { image: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: CONTENT_LIMIT }),
    prisma.testimonial.findMany({ where: { isActive: true }, include: { avatar: true, product: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: CONTENT_LIMIT }),
  ]);

  const heroSlides: HomeHeroSlide[] = slides.flatMap((s) => {
    const alt = s.heading ?? 'ArtQ';
    const video = videoRef(s.media, url);
    // A video slide uses its second (mobile) image as the poster: shown first, and instead of the video on save-data.
    const image = video ? mediaRef(s.mobileMedia, alt, url) : mediaRef(s.media, alt, url);
    if (!video && !image) return [];
    return [{ id: s.id, heading: s.heading, subheading: s.subheading, ctaText: s.ctaText, ctaLink: s.ctaLink, image, mobileImage: video ? null : mediaRef(s.mobileMedia, alt, url), video }];
  });
  const publicProduct = (p: { status: string; deletedAt: Date | null; slug: string; name: string } | null) => (p && p.status === 'ACTIVE' && !p.deletedAt ? { slug: p.slug, name: p.name } : null);
  const view: Omit<HomeView, 'sections'> = {
    hero: { slides: heroSlides, intervalMs: hero.slideIntervalMs },
    types: types.map((t) => ({ id: t.id, name: t.name, slug: t.slug, href: t.tileLinkUrl ?? `/type/${t.slug}`, image: mediaRef(t.image, t.name, url) })),
    newArrivals, trending,
    reels: reels.flatMap((r) => {
      const video = videoRef(r.video, url);
      return video ? [{ id: r.id, title: r.title, video, poster: mediaRef(r.thumbnail, r.title ?? 'ArtQ reel', url), product: publicProduct(r.product), instagramUrl: r.instagramUrl }] : [];
    }),
    techniques: techniques.map((t) => ({ id: t.id, name: t.name, slug: t.slug, image: mediaRef(t.image, t.name, url) })),
    testimonials: testimonials.map((t) => ({
      id: t.id, name: t.name, location: t.location, quote: t.quote, rating: Math.min(5, Math.max(1, t.rating)),
      avatar: mediaRef(t.avatar, t.name, url), product: publicProduct(t.product),
    })),
    instagram: insta.enabled && insta.handle ? { handle: insta.handle.replace(/^@/, ''), url: social.instagram ?? `https://www.instagram.com/${insta.handle.replace(/^@/, '')}` } : { handle: null, url: null },
  };
  const filled: Record<HomeSectionKey, boolean> = {
    hero: true,                                                     // the page falls back to the brand hero without slides
    types: view.types.length > 0,
    'new-arrivals': view.newArrivals.length > 0,
    reels: view.reels.length > 0,
    trending: view.reels.length === 0 && view.trending.length > 0,  // "Trending now" falls back to products without reels
    techniques: view.techniques.length > 0,
    testimonials: view.testimonials.length > 0,
    instagram: view.instagram.handle !== null,
  };
  const known = new Set<string>(HOME_SECTION_KEYS);
  const order = [...new Set(sectionsSetting.order)].filter((k): k is HomeSectionKey => known.has(k));
  return { sections: order.filter((k) => !sectionsSetting.hidden.includes(k) && filled[k]), ...view };
}
