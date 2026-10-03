// Storefront request schemas and public response shapes (api.md §3.1–§3.2). One schema per request, imported by the API
// route and the storefront form (validation rule, CLAUDE.md).
import { z } from 'zod';
import { emailField } from './auth-schemas.js';
import { DEFAULT_SETTINGS, type SettingKey, type SettingValue } from './settings.js';

/** Where a newsletter sign-up came from (`newsletter_subscribers.source`, varchar 20). */
export const NEWSLETTER_SOURCES = ['footer', 'checkout', 'account'] as const;
export const newsletterSubscribeBody = z.strictObject({ email: emailField, source: z.enum(NEWSLETTER_SOURCES).default('footer') });
export type NewsletterSubscribeBody = z.input<typeof newsletterSubscribeBody>;

/** The search box (header overlay, /search page) and GET /v1/search?q= (task 3.7) share this rule. */
export const SEARCH_QUERY_MAX = 100;
export const searchQueryField = z.string().trim().min(1, 'Type what you are looking for').max(SEARCH_QUERY_MAX, `Use at most ${SEARCH_QUERY_MAX} characters`);
export const searchForm = z.strictObject({ q: searchQueryField });

/** GET /v1/navigation: active types shown in the menu, each with its active categories, in admin order. */
export type NavigationCategory = { id: number; name: string; slug: string };
export type NavigationType = { id: number; name: string; slug: string; href: string; categories: NavigationCategory[] };
export type Navigation = { types: NavigationType[] };

/** GET /v1/settings/public: only what pages need; contact details the owner has not filled in are null. */
export type PublicSettings = {
  store: { name: string; phone: string | null; email: string | null; whatsapp: string | null };
  announcement: { enabled: boolean; messages: string[] };
  social: { instagram: string | null; facebook: string | null; youtube: string | null; whatsapp: string | null };
  shipping: { freeThreshold: number; estimatedDays: { min: number; max: number } };
  payment: { codEnabled: boolean; codFee: number; codMin: number; codMax: number };
  order: { returnWindowHours: number };
  home: { order: string[]; hidden: string[]; heroSlideIntervalMs: number; instagram: { enabled: boolean; handle: string | null } };
};

/** Builds the public view from settings values (the API passes stored values; pages fall back to the defaults). */
export function toPublicSettings(get: <K extends SettingKey>(key: K) => SettingValue<K>): PublicSettings {
  const store = get('STORE_INFO'), ann = get('ANNOUNCEMENT_BAR'), social = get('SOCIAL'), ship = get('SHIPPING'), pay = get('PAYMENT');
  const sections = get('HOME_SECTIONS'), insta = get('INSTAGRAM_MOMENTS');
  return {
    // GSTIN, legal name and address belong on invoices, not in every page's payload.
    store: { name: store.name, phone: store.phone, email: store.email, whatsapp: store.whatsapp ?? social.whatsapp },
    announcement: { enabled: ann.enabled, messages: ann.messages },
    social,
    shipping: { freeThreshold: ship.freeThreshold, estimatedDays: ship.estimatedDays },
    payment: { codEnabled: pay.codEnabled, codFee: pay.codFee, codMin: pay.codMin, codMax: pay.codMax },
    order: { returnWindowHours: get('ORDER').returnWindowHours },
    home: { order: sections.order, hidden: sections.hidden, heroSlideIntervalMs: get('HERO').slideIntervalMs, instagram: { enabled: insta.enabled, handle: insta.handle } },
  };
}
export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = toPublicSettings((key) => DEFAULT_SETTINGS[key]);

/** Home page sections (product.md §5.1), in the default order of the HOME_SECTIONS setting. */
export const HOME_SECTION_KEYS = ['hero', 'types', 'new-arrivals', 'reels', 'trending', 'techniques', 'testimonials', 'instagram'] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

/** A READY public image (api.md §2): `url` is a mid-size rendition, `srcset` lists every width for `sizes`. */
export type MediaRef = { id: number; url: string; width: number; height: number; alt: string; placeholder: string | null; srcset: { webp: string } };
/** A READY public video (hero, reels). */
export type VideoRef = { id: number; url: string; mime: string; width: number | null; height: number | null };

/** api.md §2 ProductCard: prices in paise over the product's active variants; only ACTIVE products are ever returned. */
export type ProductCard = {
  id: number; slug: string; name: string;
  image: MediaRef | null; hoverImage: MediaRef | null;
  fromPrice: number; maxPrice: number; mrp: number | null; discountPercent: number | null;
  inStock: boolean; isNew: boolean; isTrending: boolean;
  variantCount: number; defaultVariantId: number | null;
  type: { slug: string; name: string };
};

export type HomeHeroSlide = { id: number; heading: string | null; subheading: string | null; ctaText: string | null; ctaLink: string | null; image: MediaRef | null; mobileImage: MediaRef | null; video: VideoRef | null };
export type HomeTypeTile = { id: number; name: string; slug: string; href: string; image: MediaRef | null };
export type HomeReel = { id: number; title: string | null; video: VideoRef; poster: MediaRef | null; product: { slug: string; name: string } | null; instagramUrl: string | null };
export type HomeTechnique = { id: number; name: string; slug: string; image: MediaRef | null };
export type HomeTestimonial = { id: number; name: string; location: string | null; quote: string; rating: number; avatar: MediaRef | null; product: { slug: string; name: string } | null };

/** GET /v1/home. `sections` is the HOME_SECTIONS order without hidden or empty sections (the hero always has a fallback). */
export type HomeView = {
  sections: HomeSectionKey[];
  hero: { slides: HomeHeroSlide[]; intervalMs: number };
  types: HomeTypeTile[];
  newArrivals: ProductCard[];
  trending: ProductCard[];
  reels: HomeReel[];
  techniques: HomeTechnique[];
  testimonials: HomeTestimonial[];
  instagram: { handle: string | null; url: string | null };
};

// ── Product detail, availability, cart, notify-me (api.md §2, §3.3, §3.7; tasks 3.4 / 4.1) ──
export const MAX_CART_QUANTITY = 50;
const variantIdField = z.number({ error: 'Choose an option' }).int().positive('Choose an option');
export const cartAddBody = z.strictObject({
  variantId: variantIdField,
  quantity: z.number().int('Use a whole number').min(1, 'Add at least 1').max(MAX_CART_QUANTITY, `At most ${MAX_CART_QUANTITY} per item`).default(1),
});
export const cartUpdateBody = z.strictObject({ quantity: z.number().int('Use a whole number').min(0, 'Use 0 to remove').max(MAX_CART_QUANTITY, `At most ${MAX_CART_QUANTITY} per item`) });
export const notifyMeBody = z.strictObject({ variantId: variantIdField, email: emailField });

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
/** A sellable variant as shown on product pages (no live stock: that comes from /availability). */
export type PublicVariant = {
  id: number; sku: string; label: string; size: string | null; color: string | null; colorHex: string | null; thickness: string | null;
  price: number; mrp: number | null; discountPercent: number | null; image: MediaRef | null;
};
export type ProductDetail = {
  id: number; slug: string; name: string; shortDescription: string | null; description: string | null;
  type: { slug: string; name: string }; category: { slug: string; name: string } | null;
  images: MediaRef[]; variants: PublicVariant[];
  /** Option dimensions with more than one value, in selector order (Size → Colour → Thickness). */
  options: { size: string[]; color: { name: string; hex: string | null }[]; thickness: string[] };
  fromPrice: number; maxPrice: number; isNew: boolean; isTrending: boolean;
  /** Content sections (product.md §5.3 accordions). `description` is HTML sanitised when saved in the admin. */
  productDetails: string[]; specificationsCare: string[]; howToUse: string | null; specifications: { label: string; value: string }[];
  techniques: { slug: string; name: string }[];
  video: VideoRef | null;
  metaTitle: string | null; metaDescription: string | null;
  /** Any active variant has stock (aggregate, may be up to a minute old; the page shows live stock from /availability). */
  inStock: boolean;
};
export type RelatedProducts = { frequentlyBoughtTogether: ProductCard[]; similar: ProductCard[] };

/** A pincode as entered on the product page and at checkout. */
export const pincodeField = z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode');
export const pincodeForm = z.strictObject({ pincode: pincodeField });
/** GET /v1/pincodes/:pincode/serviceability (no-store). */
export type PincodeCheck = {
  pincode: string; place: { district: string; state: string } | null;
  serviceable: boolean; codAvailable: boolean; surfaceOnly: boolean; estimatedDays: { min: number; max: number } | null;
  reason: 'UNKNOWN_PINCODE' | 'NOT_SERVICEABLE' | null;
};
export type Availability = { variants: { id: number; price: number; mrp: number | null; discountPercent: number | null; stockStatus: StockStatus; maxQuantity: number }[] };

/** GET /v1/cart (api.md §2 CartView; shipping and COD arrive with checkout). */
export type CartView = {
  items: {
    id: number; variantId: number; productSlug: string; productName: string; variantLabel: string; image: MediaRef | null;
    unitPrice: number; unitMrp: number | null; quantity: number; lineTotal: number; maxQuantity: number; available: boolean; priceChanged: boolean; warning?: string;
  }[];
  /** The cart's coupon; `applied: false` with the reason while the cart does not qualify (it stays on the cart). */
  coupon: {
    code: string; title: string; summary: string; type: 'PERCENT' | 'FLAT' | 'FREE_SHIPPING'; applied: boolean; discount: number; freeShipping: boolean;
    problem: { code: 'COUPON_INVALID' | 'COUPON_EXPIRED' | 'COUPON_USAGE_EXCEEDED' | 'COUPON_NOT_ELIGIBLE' | 'COUPON_MIN_ORDER'; message: string; shortBy?: number } | null;
  } | null;
  totals: {
    itemCount: number; subtotal: number; mrpTotal: number; mrpDiscount: number; couponDiscount: number;
    shipping: { amount: number | null; estimated: boolean; freeApplied: boolean };
    codFee: number; total: number; savings: number; freeShippingThreshold: number; freeShippingRemaining: number;
  };
  warnings: string[];
};

// ── Listing (api.md §3.3 GET /products, product.md §5.2, architecture.md §6.2) ──
export const LISTING_SORTS = ['featured', 'newest', 'price_asc', 'price_desc', 'name_asc', 'best_selling', 'relevance'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];
export const LISTING_PAGE_SIZE = 24;
export const LISTING_MAX_LIMIT = 96;
/** A repeated query parameter (?size=10 gm&size=50 gm) or a single one, as a de-duplicated list. */
const valueList = z.union([z.string(), z.array(z.string())])
  .transform((v) => [...new Set((Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean))])
  .pipe(z.array(z.string().max(80, 'Use at most 80 characters')).max(20, 'Choose at most 20'));
const flag = z.enum(['1', 'true']).transform(() => true);
const paiseParam = z.coerce.number({ error: 'Enter a number' }).int('Use whole rupees').min(0, 'Use 0 or more').max(1_00_00_000);
/** GET /v1/products. Prices in paise. `relevance` needs `q`. */
export const storefrontListQuery = z.strictObject({
  type: valueList.optional(), category: valueList.optional(), technique: valueList.optional(),
  size: valueList.optional(), color: valueList.optional(), thickness: valueList.optional(),
  q: z.string().trim().max(SEARCH_QUERY_MAX, `Use at most ${SEARCH_QUERY_MAX} characters`).optional(),
  minPrice: paiseParam.optional(), maxPrice: paiseParam.optional(),
  inStock: flag.optional(), sale: flag.optional(), isNew: flag.optional(), isTrending: flag.optional(),
  sort: z.enum(LISTING_SORTS).optional(),
  page: z.coerce.number().int().min(1).max(200).default(1),
  limit: z.coerce.number().int().min(1).max(LISTING_MAX_LIMIT).default(LISTING_PAGE_SIZE),
}).refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, { path: ['maxPrice'], message: 'The maximum must be at least the minimum' })
  .refine((q) => q.sort !== 'relevance' || Boolean(q.q), { path: ['sort'], message: 'Relevance needs a search' });
export type StorefrontListQuery = z.output<typeof storefrontListQuery>;

/** The storefront's price filter (whole rupees); the same limits as the API's paise parameters. */
const rupees = z.union([z.literal(''), z.coerce.number({ error: 'Enter a number' }).int('Use whole rupees').min(0, 'Use 0 or more').max(1_00_000, 'At most ₹1,00,000')]);
export const priceRangeForm = z.object({ min: rupees, max: rupees })
  .refine((r) => r.min === '' || r.max === '' || r.min <= r.max, { path: ['max'], message: 'The maximum must be at least the minimum' });

export type Facet = { value: string; label: string; count: number; hex?: string | null };
export type ProductList = {
  data: ProductCard[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  facets: { types: Facet[]; categories: Facet[]; techniques: Facet[]; sizes: Facet[]; colors: Facet[]; thicknesses: Facet[]; price: { min: number; max: number } | null };
};

/** GET /v1/types/:slug, /categories/:slug, /techniques/:slug: the listing page header. */
export type TaxonomyPage = {
  kind: 'type' | 'category' | 'technique'; name: string; slug: string; description: string | null;
  banner: MediaRef | null; metaTitle: string | null; metaDescription: string | null;
  parent: { slug: string; name: string } | null;
  children: { slug: string; name: string }[];
};

// ── Search (api.md §3.3 /search, /search/suggest; task 3.7) ──
export const SUGGEST_MIN = 2;
export const searchSuggestQuery = z.strictObject({ q: z.string().trim().min(SUGGEST_MIN, `Type at least ${SUGGEST_MIN} characters`).max(SEARCH_QUERY_MAX, `Use at most ${SEARCH_QUERY_MAX} characters`) });
export type SearchSuggestions = {
  products: { id: number; slug: string; name: string; image: MediaRef | null; fromPrice: number }[];
  categories: { slug: string; name: string; typeName: string }[];
  types: { slug: string; name: string; href: string }[];
};
/** GET /v1/search: a listing plus, when nothing matched, the closest product name ("Did you mean …"). */
export type SearchResults = ProductList & { query: string; suggestion: string | null };

/** WhatsApp chat link for a stored number ("+91 98470 12345", "919847012345", "09847012345"); null when it is not a usable Indian or international number. */
export function whatsappHref(number: string | null | undefined, text?: string): string | null {
  if (!number) return null;
  let digits = number.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (/^0\d{10}$/.test(digits)) digits = `91${digits.slice(1)}`;
  else if (/^\d{10}$/.test(digits)) digits = `91${digits}`;
  if (!/^\d{11,15}$/.test(digits)) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
