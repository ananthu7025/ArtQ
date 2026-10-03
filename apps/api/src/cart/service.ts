// Cart (api.md §3.7, task 4.1 core brought forward for quick add in 3.4). A cart is identified by a random token in an
// HttpOnly cookie; only its SHA-256 is stored (architecture.md §5.1). Carts never reserve stock: adding checks what is
// available now, and every read re-prices from the database, lowers quantities above current stock and flags price
// changes. Totals come from the shared pricing engine (§6.4); coupon, shipping and COD arrive with checkout (Phase 4).
import { createHash, randomBytes } from 'node:crypto';
import { formatINR, freeShippingRemaining, MAX_CART_QUANTITY, priceCart, type CartView, type PricingVariant } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { mediaRef, setting, type MediaUrl } from '../storefront/home.js';

export const CART_TTL_S = 30 * 86_400;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

type Row = {
  item_id: number; variant_id: number; quantity: number; added_price: number; sku: string; label: string; price: number | null; mrp: number | null;
  available: number; variant_active: boolean; variant_deleted: boolean; product_id: number; product_slug: string; product_name: string; product_live: boolean;
  type_id: number | null; category_id: number | null; gst_rate: string | null; weight_g: number | null; length_cm: string | null; width_cm: string | null; height_cm: string | null;
  shipping_class: 'STANDARD' | 'BULKY' | 'SURFACE_ONLY'; image_media_id: number | null;
};

export class CartService {
  constructor(private readonly prisma: PrismaClient, private readonly mediaUrl: MediaUrl) {}

  /**
   * The active GUEST cart for a cookie token, or null. A cart that belongs to an account is never reachable by its
   * cookie alone, so after a logout on a shared computer the next person does not see it.
   */
  async find(token: string | undefined): Promise<{ id: number } | null> {
    if (!token) return null;
    return this.prisma.cart.findFirst({ where: { tokenHash: hashToken(token), status: 'ACTIVE', userId: null }, select: { id: true } });
  }

  /** The account's active cart (the same on every device), or null. */
  async forUser(userId: number): Promise<{ id: number } | null> {
    return this.prisma.cart.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { lastActivityAt: 'desc' }, select: { id: true } });
  }

  async create(userId: number | null = null): Promise<{ id: number; token: string }> {
    const token = newToken();
    const cart = await this.prisma.cart.create({ data: { tokenHash: hashToken(token), userId } });
    return { id: cart.id, token };
  }

  /**
   * At sign-in (api.md §3.4 "merges cart"): the guest cart joins the account. No account cart yet → the guest cart
   * becomes it. Otherwise its lines are added to the account cart (same variant: quantities added, capped at what is
   * available and at 50) and the guest cart is marked MERGED. Returns the account cart id.
   */
  async claim(guestToken: string | undefined, userId: number): Promise<number | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE`;   // one claim per account at a time
      const guest = guestToken ? await tx.cart.findFirst({ where: { tokenHash: hashToken(guestToken), status: 'ACTIVE', userId: null } }) : null;
      const mine = await tx.cart.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { lastActivityAt: 'desc' } });
      if (!guest) return mine?.id ?? null;
      if (!mine) { await tx.cart.update({ where: { id: guest.id }, data: { userId, lastActivityAt: new Date() } }); return guest.id; }
      const lines = await tx.$queryRaw<{ variant_id: number; quantity: number; added_price: number; available: number }[]>`
        SELECT ci.variant_id, ci.quantity, ci.added_price, GREATEST(v.on_hand - v.reserved, 0)::int AS available
          FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id WHERE ci.cart_id = ${guest.id}`;
      for (const l of lines) {
        const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: mine.id, variantId: l.variant_id } } });
        const quantity = Math.max(1, Math.min((existing?.quantity ?? 0) + l.quantity, MAX_CART_QUANTITY, Math.max(l.available, existing?.quantity ?? 1)));
        await tx.cartItem.upsert({ where: { cartId_variantId: { cartId: mine.id, variantId: l.variant_id } }, create: { cartId: mine.id, variantId: l.variant_id, quantity, addedPrice: l.added_price }, update: { quantity } });
      }
      await tx.cart.update({ where: { id: guest.id }, data: { status: 'MERGED' } });
      await tx.cart.update({ where: { id: mine.id }, data: { lastActivityAt: new Date() } });
      return mine.id;
    });
  }

  /** Adds `quantity` of a variant (merging with the same variant already in the cart). */
  async add(cartId: number, variantId: number, quantity: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId} FOR UPDATE`;   // one change to a cart at a time
      const [v] = await tx.$queryRaw<{ price: number; available: number }[]>`
        SELECT v.price, GREATEST(v.on_hand - v.reserved, 0)::int AS available FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ${variantId} AND v.is_active AND v.deleted_at IS NULL AND v.price IS NOT NULL AND p.status = 'ACTIVE' AND p.deleted_at IS NULL`;
      if (!v) throw new AppError(404, 'NOT_FOUND', 'This option is no longer available');
      const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
      const inCart = existing?.quantity ?? 0;
      const total = inCart + quantity;
      if (total > MAX_CART_QUANTITY) throw new AppError(422, 'QUANTITY_LIMIT', `You can buy at most ${MAX_CART_QUANTITY} of one item`, { max: MAX_CART_QUANTITY, inCart });
      if (total > v.available) {
        throw new AppError(409, 'OUT_OF_STOCK', v.available === 0 ? 'This option is out of stock' : `Only ${v.available} left${inCart ? ` (you already have ${inCart} in your cart)` : ''}`, { available: v.available, inCart });
      }
      await tx.cartItem.upsert({ where: { cartId_variantId: { cartId, variantId } }, create: { cartId, variantId, quantity: total, addedPrice: v.price }, update: { quantity: total, addedPrice: v.price } });
      await tx.cart.update({ where: { id: cartId }, data: { lastActivityAt: new Date() } });
    });
  }

  /** Sets an item's quantity (0 removes it). Raising it is checked against stock like an add. */
  async update(cartId: number, itemId: number, quantity: number): Promise<void> {
    const item = await this.prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
    if (!item) throw new AppError(404, 'NOT_FOUND', 'This item is no longer in your cart');
    if (quantity === 0) { await this.remove(cartId, itemId); return; }
    if (quantity > item.quantity) { await this.add(cartId, item.variantId, quantity - item.quantity); return; }
    await this.prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
  }

  async remove(cartId: number, itemId: number): Promise<void> {
    const { count } = await this.prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
    if (count === 0) throw new AppError(404, 'NOT_FOUND', 'This item is no longer in your cart');
  }

  async clear(cartId: number): Promise<void> {
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
  }

  /** The cart as the customer sees it now: re-priced, quantities lowered to what is in stock, changes explained. */
  async view(cartId: number | null): Promise<CartView> {
    const [ship, pay] = await Promise.all([setting(this.prisma, 'SHIPPING'), setting(this.prisma, 'PAYMENT')]);
    const rows = cartId === null ? [] : await this.prisma.$queryRaw<Row[]>`
      SELECT ci.id AS item_id, ci.variant_id, ci.quantity, ci.added_price, v.sku, v.label, v.price, v.mrp, GREATEST(v.on_hand - v.reserved, 0)::int AS available,
             v.is_active AS variant_active, v.deleted_at IS NOT NULL AS variant_deleted, p.id AS product_id, p.slug AS product_slug, p.name AS product_name,
             (p.status = 'ACTIVE' AND p.deleted_at IS NULL) AS product_live, p.type_id, p.category_id, p.gst_rate::text, v.weight_g,
             v.length_cm::text, v.width_cm::text, v.height_cm::text, v.shipping_class::text AS shipping_class,
             coalesce(v.image_media_id, (SELECT pi.media_id FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_cover DESC, pi.sort_order, pi.id LIMIT 1)) AS image_media_id
      FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
      WHERE ci.cart_id = ${cartId} ORDER BY ci.created_at, ci.id`;
    const media = await this.prisma.media.findMany({ where: { id: { in: rows.map((r) => r.image_media_id).filter((x): x is number => x !== null) } } });
    const warnings: string[] = [];
    const items: CartView['items'] = [];
    const lines: { variantId: number; quantity: number }[] = [];
    const variants: PricingVariant[] = [];
    for (const r of rows) {
      const sellable = r.product_live && r.variant_active && !r.variant_deleted && r.price !== null && r.gst_rate !== null;
      let quantity = r.quantity;
      let warning: string | undefined;
      if (!sellable) warning = 'No longer available';
      else if (r.available === 0) warning = 'Out of stock';
      else if (quantity > r.available) {
        quantity = Math.min(r.available, MAX_CART_QUANTITY);
        warning = `Only ${r.available} left, so we changed the quantity to ${quantity}`;
        await this.prisma.cartItem.update({ where: { id: r.item_id }, data: { quantity } });
      }
      const priceChanged = sellable && r.price !== r.added_price;
      if (priceChanged && !warning) warning = `Price changed from ${formatINR(r.added_price)} to ${formatINR(r.price!)}`;
      if (warning) warnings.push(`${r.product_name} (${r.label}): ${warning}`);
      const available = sellable && r.available > 0;
      if (available) {
        lines.push({ variantId: r.variant_id, quantity });
        variants.push({
          variantId: r.variant_id, productId: r.product_id, typeId: r.type_id, categoryId: r.category_id, sellable: true, price: r.price, mrp: r.mrp,
          gstRate: Number(r.gst_rate), available: r.available, weightG: r.weight_g ?? 0, shippingClass: r.shipping_class,
          dimsCm: r.length_cm && r.width_cm && r.height_cm ? { length: Number(r.length_cm), width: Number(r.width_cm), height: Number(r.height_cm) } : null,
        });
      }
      items.push({
        id: r.item_id, variantId: r.variant_id, productSlug: r.product_slug, productName: r.product_name, variantLabel: r.label,
        image: mediaRef(media.find((m) => m.id === r.image_media_id), `${r.product_name}, ${r.label}`, this.mediaUrl),
        unitPrice: r.price ?? r.added_price, unitMrp: r.mrp !== null && r.price !== null && r.mrp > r.price ? r.mrp : null, quantity,
        lineTotal: available ? r.price! * quantity : 0, maxQuantity: available ? Math.min(r.available, MAX_CART_QUANTITY) : 0, available, priceChanged,
        ...(warning ? { warning } : {}),
      });
    }
    // Once shown, a price change is the new reference (the customer has now seen it).
    const changed = rows.filter((r) => r.price !== null && r.price !== r.added_price).map((r) => r.item_id);
    for (const id of changed) { const r = rows.find((x) => x.item_id === id)!; await this.prisma.cartItem.update({ where: { id }, data: { addedPrice: r.price! } }); }

    const priced = priceCart({ lines, variants, coupon: null, destination: null, paymentMethod: null, settings: { shipping: ship, payment: { codEnabled: pay.codEnabled, codFee: pay.codFee, codMin: pay.codMin, codMax: pay.codMax } } });
    return {
      items, coupon: null, warnings,
      totals: {
        itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal: priced.subtotal, mrpTotal: priced.mrpTotal, mrpDiscount: priced.mrpDiscount, couponDiscount: 0,
        shipping: { amount: null, estimated: true, freeApplied: priced.subtotal > 0 && priced.subtotal >= ship.freeThreshold },
        codFee: 0, total: priced.subtotal, savings: priced.mrpDiscount,
        freeShippingThreshold: ship.freeThreshold, freeShippingRemaining: priced.subtotal === 0 ? ship.freeThreshold : freeShippingRemaining(priced.subtotal, 0, ship.freeThreshold),
      },
    };
  }
}
