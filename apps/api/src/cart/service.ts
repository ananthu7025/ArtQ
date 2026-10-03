// Cart (api.md §3.7, task 4.1 core brought forward for quick add in 3.4). A cart is identified by a random token in an
// HttpOnly cookie; only its SHA-256 is stored (architecture.md §5.1). Carts never reserve stock: adding checks what is
// available now, and every read re-prices from the database, lowers quantities above current stock and flags price
// changes. Totals come from the shared pricing engine (§6.4) with the cart's coupon (task 4.3); shipping and COD arrive with
// checkout.
import { createHash, randomBytes } from 'node:crypto';
import { formatINR, freeShippingRemaining, MAX_CART_QUANTITY, priceCart, type CartView, type CheckoutPaymentMethod, type CheckoutQuote, type PricingVariant, type PublicCoupon, type ShippingProblem } from '@artq/shared';
import type { PrismaClient } from '@prisma/client';
import { destinationFor } from '../shipping/destination.js';
import { CouponService, couponMessage, summaryOf, toPricingCoupon, type CouponCustomer } from '../coupons/service.js';
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
  private readonly coupons: CouponService;
  constructor(private readonly prisma: PrismaClient, private readonly mediaUrl: MediaUrl) { this.coupons = new CouponService(prisma); }

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

  /** The cart's lines re-read from the database: quantities lowered to what is in stock, changes explained. */
  private async load(cartId: number | null) {
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
        id: r.item_id, variantId: r.variant_id, productId: r.product_id, productSlug: r.product_slug, productName: r.product_name, variantLabel: r.label,
        image: mediaRef(media.find((m) => m.id === r.image_media_id), `${r.product_name}, ${r.label}`, this.mediaUrl),
        unitPrice: r.price ?? r.added_price, unitMrp: r.mrp !== null && r.price !== null && r.mrp > r.price ? r.mrp : null, quantity,
        lineTotal: available ? r.price! * quantity : 0, maxQuantity: available ? Math.min(r.available, MAX_CART_QUANTITY) : 0, available, priceChanged,
        ...(warning ? { warning } : {}),
      });
    }
    // Once shown, a price change is the new reference (the customer has now seen it).
    const changed = rows.filter((r) => r.price !== null && r.price !== r.added_price).map((r) => r.item_id);
    for (const id of changed) { const r = rows.find((x) => x.item_id === id)!; await this.prisma.cartItem.update({ where: { id }, data: { addedPrice: r.price! } }); }

    return { items, lines, variants, warnings, onlineEnabled: pay.razorpayEnabled, settings: { shipping: ship, payment: { codEnabled: pay.codEnabled, codFee: pay.codFee, codMin: pay.codMin, codMax: pay.codMax } } };
  }

  /** Who the coupon checks are for: the account, or the email given at checkout. */
  private async customerOf(cartId: number): Promise<{ couponId: number | null; who: CouponCustomer }> {
    const c = await this.prisma.cart.findUnique({ where: { id: cartId }, select: { couponId: true, userId: true, contactEmail: true, user: { select: { email: true } } } });
    return { couponId: c?.couponId ?? null, who: { userId: c?.userId ?? null, email: c?.contactEmail ?? c?.user?.email ?? null } };
  }

  /**
   * The cart as the customer sees it now: re-priced, with its coupon re-checked. A coupon that stops qualifying (an item
   * removed, the coupon used up or expired) stays on the cart with the reason and no discount, and applies again by
   * itself once the cart qualifies.
   */
  async view(cartId: number | null, pincode: string | null = null): Promise<CartView> {
    return (await this.compute(cartId, pincode, null)).view;
  }

  /** The cart priced for an optional pincode and payment method, with the pricing engine's full output. */
  private async compute(cartId: number | null, pincode: string | null, paymentMethod: CheckoutPaymentMethod | null) {
    const { items, lines, variants, warnings, settings, onlineEnabled } = await this.load(cartId);
    const { couponId, who } = cartId === null ? { couponId: null, who: { userId: null, email: null } } : await this.customerOf(cartId);
    const coupon = couponId === null ? null : await this.coupons.findById(couponId);
    if (couponId !== null && !coupon) await this.prisma.cart.update({ where: { id: cartId! }, data: { couponId: null } });   // deleted meanwhile
    const check = coupon ? await this.coupons.check(coupon, who) : null;
    // Shipping estimate for a pincode (task 4.5): the one algorithm with the destination's zone and delivery rule.
    const dest = pincode && lines.length ? await destinationFor(this.prisma, pincode) : null;
    let shipProblem: ShippingProblem | null = null;
    if (dest && !dest.place && !dest.fromRule) shipProblem = 'UNKNOWN_PINCODE';
    else if (dest && !dest.serviceability.serviceable) shipProblem = 'PINCODE_NOT_SERVICEABLE';
    else if (dest && !dest.zone) shipProblem = 'NO_ZONE';
    const destination = dest?.zone && !shipProblem ? { gstStateCode: dest.place?.gstStateCode ?? '', zone: dest.zone, serviceability: dest.serviceability } : null;
    const priced = priceCart({ lines, variants, coupon: coupon && check?.ok ? toPricingCoupon(coupon) : null, destination, paymentMethod, settings });
    let couponView: CartView['coupon'] = null;
    if (coupon) {
      let problem: NonNullable<CartView['coupon']>['problem'] = null;
      if (check && !check.ok) problem = { code: check.code, message: check.message };
      else if (lines.length === 0) problem = { code: 'COUPON_NOT_ELIGIBLE', message: couponMessage.empty };
      else if (priced.coupon && !priced.coupon.applied) {
        problem = priced.coupon.error === 'COUPON_MIN_ORDER'
          ? { code: 'COUPON_MIN_ORDER', message: couponMessage.minOrder(priced.coupon.shortBy), shortBy: priced.coupon.shortBy }
          : { code: 'COUPON_NOT_ELIGIBLE', message: couponMessage.scope };
      }
      couponView = {
        code: coupon.code, title: coupon.title, summary: summaryOf(coupon), type: coupon.type, applied: problem === null,
        discount: problem === null ? priced.couponDiscount : 0, freeShipping: problem === null && coupon.type === 'FREE_SHIPPING', problem,
      };
    }
    const ship = settings.shipping;
    const couponDiscount = couponView?.applied ? priced.couponDiscount : 0;
    const quote = priced.shipping;
    if (quote && !quote.ok) shipProblem = quote.error;
    const amount = quote?.ok ? quote.shipping : null;
    const freeApplied = quote?.ok ? quote.freeShippingApplied : priced.subtotal > 0 && (couponView?.freeShipping === true || priced.subtotal - couponDiscount >= ship.freeThreshold);
    const view: CartView = {
      items, coupon: couponView, warnings,
      totals: {
        itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal: priced.subtotal, mrpTotal: priced.mrpTotal, mrpDiscount: priced.mrpDiscount, couponDiscount,
        shipping: { amount, estimated: amount === null, freeApplied, heavySurcharge: quote?.ok ? quote.heavySurcharge : 0, pincode: dest ? pincode : null, problem: shipProblem },
        codFee: priced.codFee, total: priced.subtotal - couponDiscount + (amount ?? 0) + priced.codFee, savings: priced.mrpDiscount + couponDiscount + (quote?.ok ? quote.rate - quote.shipping : 0),
        freeShippingThreshold: ship.freeThreshold,
        freeShippingRemaining: priced.subtotal === 0 ? ship.freeThreshold : freeApplied ? 0 : freeShippingRemaining(priced.subtotal, couponDiscount, ship.freeThreshold),
      },
    };
    // Why the order cannot be placed as it stands: the engine's reasons, with the real delivery problem when known.
    const blocking = [...(shipProblem ? [shipProblem] : []), ...priced.blocking.filter((b) => !(shipProblem && b === 'DESTINATION_REQUIRED'))];
    return { view, priced, settings, onlineEnabled, blocking };
  }

  /**
   * POST /checkout/quote (task 4.6): the cart priced for a delivery pincode (a saved address of this customer, or the
   * pincode being typed) and a payment method, with COD availability and what still blocks the order.
   */
  async quote(cartId: number | null, userId: number | null, body: { shippingAddressId?: number | undefined; pincode?: string | undefined; paymentMethod: CheckoutPaymentMethod }): Promise<CheckoutQuote> {
    let pincode = body.pincode ?? null;
    if (body.shippingAddressId !== undefined) {
      const a = userId === null ? null : await this.prisma.address.findFirst({ where: { id: body.shippingAddressId, userId }, select: { pincode: true } });
      if (!a) throw new AppError(404, 'NOT_FOUND', 'Address not found');
      pincode = a.pincode;
    }
    const { view, priced, settings, onlineEnabled, blocking } = await this.compute(cartId, pincode, body.paymentMethod);
    const pay = settings.payment;
    return {
      cart: view, onlineEnabled,
      cod: { available: priced.cod.available, reason: priced.cod.available ? null : priced.cod.reason, fee: pay.codFee, min: pay.codMin, max: pay.codMax },
      blocking: [...blocking, ...(body.paymentMethod === 'RAZORPAY' && !onlineEnabled ? ['ONLINE_DISABLED'] : [])],
    };
  }

  /**
   * POST /cart/coupon: puts the coupon on the cart only if it applies now (one coupon per cart: it replaces the last
   * one). Refused with the first failing check of product.md §8.4. Nothing is reserved until checkout.
   */
  async applyCoupon(cartId: number | null, code: string, pincode: string | null = null): Promise<CartView> {
    const coupon = await this.coupons.findByCode(code);
    if (!coupon) throw new AppError(422, 'COUPON_INVALID', couponMessage.invalid);
    if (cartId === null) throw new AppError(422, 'COUPON_NOT_ELIGIBLE', couponMessage.empty);
    const { couponId: before } = await this.customerOf(cartId);
    await this.prisma.cart.update({ where: { id: cartId }, data: { couponId: coupon.id, lastActivityAt: new Date() } });
    const view = await this.view(cartId, pincode);
    const problem = view.coupon?.problem;
    if (problem) {
      await this.prisma.cart.update({ where: { id: cartId }, data: { couponId: before } });
      throw new AppError(422, problem.code, problem.message, problem.shortBy !== undefined ? { shortBy: problem.shortBy } : undefined);
    }
    return view;
  }

  async removeCoupon(cartId: number | null, pincode: string | null = null): Promise<CartView> {
    if (cartId !== null) await this.prisma.cart.update({ where: { id: cartId }, data: { couponId: null } });
    return this.view(cartId, pincode);
  }

  /** GET /cart/coupons: the public coupons, each with whether this cart qualifies now (and why not). */
  async publicCoupons(cartId: number | null): Promise<PublicCoupon[]> {
    const list = await this.coupons.listPublic();
    if (list.length === 0) return [];
    const { lines, variants, settings } = await this.load(cartId);
    const { who } = cartId === null ? { who: { userId: null, email: null } } : await this.customerOf(cartId);
    const out: PublicCoupon[] = [];
    for (const c of list) {
      const check = await this.coupons.check(c, who);
      let reason: string | null = check.ok ? null : check.message;
      if (!reason && lines.length === 0) reason = couponMessage.empty;
      if (!reason) {
        const outcome = priceCart({ lines, variants, coupon: toPricingCoupon(c), destination: null, paymentMethod: null, settings }).coupon;
        if (outcome && !outcome.applied) reason = outcome.error === 'COUPON_MIN_ORDER' ? couponMessage.minOrder(outcome.shortBy) : couponMessage.scope;
      }
      out.push({ code: c.code, title: c.title, description: c.description, type: c.type, value: c.value, maxDiscount: c.maxDiscount, minOrderValue: c.minOrderValue,
        endsAt: c.endsAt?.toISOString() ?? null, eligible: reason === null, reason });
    }
    return out;
  }
}
