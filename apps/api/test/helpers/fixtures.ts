// Test data builders (TypeScript port of tools/doc-validation/lib/db.mjs). Rows are inserted with plain SQL and every
// money/stock effect goes through the typed wrappers in src/db/functions.ts, i.e. through the real aq_* functions.
import type { PrismaClient } from '@prisma/client';
import * as fn from '../../src/db/functions.js';
import type { Db } from '../../src/db/functions.js';

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

export async function val<T = unknown>(db: Db, sql: string, ...params: unknown[]): Promise<T> {
  const rows = await db.$queryRawUnsafe<Record<string, T>[]>(sql, ...params);
  return rows[0] === undefined ? (undefined as T) : (Object.values(rows[0])[0] as T);
}

export async function one<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): Promise<T> {
  return (await db.$queryRawUnsafe<T[]>(sql, ...params))[0]!;
}

/** Interactive transaction with generous limits for the concurrency tests. */
export function tx<T>(prisma: PrismaClient, f: (db: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(f, { maxWait: 30_000, timeout: 30_000 });
}

export type Catalog = { typeId: number; categoryId: number; products: { productId: number; variantIds: number[] }[] };

/** One type + category; products given as lists of variants {price, onHand}. */
export async function catalog(db: Db, products: { price?: number; onHand?: number }[][]): Promise<Catalog> {
  const u = uniq();
  const typeId = await val<number>(db, `INSERT INTO product_types (name, slug, updated_at) VALUES ($1,$1,now()) RETURNING id`, 't' + u);
  const categoryId = await val<number>(db, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,$2,$2,now()) RETURNING id`, typeId, 'c' + u);
  const out: Catalog['products'] = [];
  for (const [i, variants] of products.entries()) {
    const productId = await val<number>(db, `INSERT INTO products (type_id, category_id, name, slug, description, updated_at)
      VALUES ($1,$2,$3,$3,'d',now()) RETURNING id`, typeId, categoryId, `p${u}-${i}`);
    const variantIds: number[] = [];
    for (const [j, v] of variants.entries()) {
      variantIds.push(await val<number>(db, `INSERT INTO product_variants (product_id, sku, size, label, price, on_hand, net_quantity, net_unit, updated_at)
        VALUES ($1,$2,$3,$3,$4,$5,1,'PCS',now()) RETURNING id`, productId, `SKU-${u}-${i}-${j}`, `s${j}`, v.price ?? 10_000, v.onHand ?? 10));
    }
    out.push({ productId, variantIds });
  }
  await fn.refreshProducts(db, out.map((p) => p.productId));
  return { typeId, categoryId, products: out };
}

export type OrderFixture = { orderId: number; orderNumber: string; total: number; items: { variantId: number; qty: number; orderItemId: number }[] };

/** Order with items priced from the variants; reserves stock through aq_reserve_order unless reserve=false. */
export async function order(db: Db, o: {
  lines: { variantId: number; qty: number }[]; method?: 'RAZORPAY' | 'COD'; shippingFee?: number; codFee?: number;
  couponDiscount?: number; reserve?: boolean;
}): Promise<OrderFixture> {
  const u = uniq();
  const method = o.method ?? 'RAZORPAY';
  const shippingFee = o.shippingFee ?? 0, codFee = o.codFee ?? 0, couponDiscount = o.couponDiscount ?? 0;
  let subtotal = 0;
  const lines: { variantId: number; qty: number; productId: number; price: number }[] = [];
  for (const l of o.lines) {
    const v = await one<{ product_id: number; price: number }>(db, `SELECT product_id, price FROM product_variants WHERE id = $1`, l.variantId);
    lines.push({ ...l, productId: v.product_id, price: v.price });
    subtotal += v.price * l.qty;
  }
  const total = subtotal - couponDiscount + shippingFee + codFee;
  const orderNumber = 'AQ' + u;
  const orderId = await val<number>(db, `INSERT INTO orders (order_number, contact_email, contact_phone, status, payment_status, payment_method,
      subtotal, mrp_total, coupon_discount, shipping_fee, cod_fee, total, actual_weight_g, chargeable_weight_g, pricing_snapshot,
      ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_pincode, tracking_token_hash, updated_at, expires_at)
    VALUES ($1::text,'buyer@example.com','+919800000000','PENDING_PAYMENT',$2::"OrderPaymentStatus",$3::"PaymentMethod",$4,$4,$5,$6,$7,$8,500,500,'{}',
            'A','+919800000000','L1','Kochi','Kerala','682016', md5($1::text)||md5($1::text), now(), now() + interval '30 minutes') RETURNING id`,
    orderNumber, method === 'COD' ? 'COD_PENDING' : 'UNPAID', method, subtotal, couponDiscount, shippingFee, codFee, total);
  let discount = couponDiscount;
  const items: OrderFixture['items'] = [];
  for (const l of lines) {
    const line = l.price * l.qty;
    const d = Math.min(discount, line);
    discount -= d;
    const orderItemId = await val<number>(db, `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, sku, unit_price,
        quantity, line_total, discount, net_amount, tax_rate, tax_amount, weight_g) VALUES ($1,$2,$3,'n','l','s',$4,$5,$6,$7,$8,18,0,100) RETURNING id`,
      orderId, l.productId, l.variantId, l.price, l.qty, line, d, line - d);
    items.push({ variantId: l.variantId, qty: l.qty, orderItemId });
  }
  if (o.reserve ?? true) await fn.reserveOrder(db, orderId);
  return { orderId, orderNumber, total, items };
}

/** A Razorpay payment attempt (provider order) for the order. */
export async function attempt(db: Db, orderId: number, amount: number) {
  const u = uniq();
  const attemptId = await val<number>(db, `INSERT INTO payment_attempts (order_id, receipt, provider_order_id, amount, status, updated_at)
    VALUES ($1,$2,$3,$4,'CREATED',now()) RETURNING id`, orderId, 'AQA_' + u, 'order_' + u, amount);
  return { attemptId, providerOrderId: 'order_' + u };
}

/** Applies a provider snapshot through aq_apply_provider_payment. */
export function capture(db: Db, p: { providerOrderId: string; paymentId: string; amount: number; status?: fn.ProviderPaymentStatus; amountRefunded?: number }) {
  return fn.applyProviderPayment(db, {
    providerOrderId: p.providerOrderId, paymentId: p.paymentId, amount: p.amount, currency: 'INR', status: p.status ?? 'CAPTURED',
    amountRefunded: p.amountRefunded ?? 0, capturedAt: new Date(), method: 'upi', raw: {}, actor: 'WEBHOOK',
  });
}

/** Settles all promises and returns fulfilled count and distinct rejection messages. */
export async function race<T>(n: number, f: () => Promise<T>) {
  const r = await Promise.allSettled(Array.from({ length: n }, f));
  const rejected = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
  return { ok: r.length - rejected.length, errors: [...new Set(rejected.map((x) => (x.reason as Error).message))] };
}
