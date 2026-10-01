// Test data helpers. Everything goes through the functions/statements documented in docs/database.md.
import pg from 'pg';

export function pool(cfg, max = 40) { return new pg.Pool({ ...cfg, max }); }

export async function tx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

export async function one(q, sql, params = []) { const r = await q.query(sql, params); return r.rows[0]; }
export async function val(q, sql, params = []) { const r = await one(q, sql, params); return r && Object.values(r)[0]; }

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

// Catalogue: one type/category, products with variants {price, onHand}
export async function catalog(q, products) {
  const u = uniq();
  const t = await val(q, `INSERT INTO product_types (name, slug, updated_at) VALUES ($1,$1,now()) RETURNING id`, ['t' + u]);
  const c = await val(q, `INSERT INTO categories (type_id, name, slug, updated_at) VALUES ($1,$2,$2,now()) RETURNING id`, [t, 'c' + u]);
  const out = [];
  for (const [i, variants] of products.entries()) {
    const p = await val(q, `INSERT INTO products (type_id, category_id, name, slug, description, updated_at)
                            VALUES ($1,$2,$3,$3,'d',now()) RETURNING id`, [t, c, `p${u}-${i}`]);
    const vids = [];
    for (const [j, v] of variants.entries()) {
      vids.push(await val(q, `INSERT INTO product_variants (product_id, sku, size, label, price, on_hand, net_quantity, net_unit, updated_at)
                              VALUES ($1,$2,$3,$3,$4,$5,1,'PCS',now()) RETURNING id`,
        [p, `SKU-${u}-${i}-${j}`, `s${j}`, v.price ?? 10000, v.onHand ?? 10]));
    }
    out.push({ productId: p, variantIds: vids });
  }
  await q.query(`SELECT aq_refresh_products($1)`, [out.map((x) => x.productId)]);
  return { typeId: t, categoryId: c, products: out };
}

// Order with items (unit price from variant) and optional shipping/cod/coupon; status PENDING_PAYMENT unless given
export async function order(q, { lines, method = 'RAZORPAY', shippingFee = 0, codFee = 0, status = 'PENDING_PAYMENT', paymentStatus,
                                  couponDiscount = 0, cartId = null, reserve = true }) {
  const u = uniq();
  let subtotal = 0; const items = [];
  for (const l of lines) {
    const v = await one(q, `SELECT id, product_id, price FROM product_variants WHERE id = $1`, [l.variantId]);
    items.push({ ...l, productId: v.product_id, price: v.price }); subtotal += v.price * l.qty;
  }
  const total = subtotal - couponDiscount + shippingFee + codFee;
  const o = await val(q, `INSERT INTO orders (order_number, cart_id, contact_email, contact_phone, status, payment_status, payment_method,
      subtotal, mrp_total, coupon_discount, shipping_fee, cod_fee, total, actual_weight_g, chargeable_weight_g, pricing_snapshot,
      ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_pincode, tracking_token_hash, updated_at, expires_at)
    VALUES ($1::text,$2,'buyer@example.com','+919800000000',$3,$4,$5,$6,$6,$7,$8,$9,$10,500,500,'{}','A','+919800000000','L1','Kochi','Kerala','682016',
            md5($1::text)||md5($1::text),now(), now() + interval '30 minutes') RETURNING id`,
    ['AQ' + u, cartId, status, paymentStatus ?? (method === 'COD' ? 'COD_PENDING' : 'UNPAID'), method, subtotal, couponDiscount,
     shippingFee, codFee, total]);
  // allocate discount to first line for simplicity
  let disc = couponDiscount;
  for (const it of items) {
    const line = it.price * it.qty; const d = Math.min(disc, line); disc -= d;
    it.orderItemId = await val(q, `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, sku, unit_price, quantity,
        line_total, discount, net_amount, tax_rate, tax_amount, weight_g) VALUES ($1,$2,$3,'n','l','s',$4,$5,$6,$7,$8,18,0,100) RETURNING id`,
      [o, it.productId, it.variantId, it.price, it.qty, line, d, line - d]);
  }
  if (reserve) await q.query(`SELECT aq_reserve_order($1)`, [o]);
  return { orderId: o, orderNumber: 'AQ' + u, total, items };
}

export async function attempt(q, orderId, amount, status = 'CREATED') {
  const u = uniq();
  const id = await val(q, `INSERT INTO payment_attempts (order_id, receipt, provider_order_id, amount, status, updated_at)
                           VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`, [orderId, 'AQA_' + u, 'order_' + u, amount, status]);
  return { attemptId: id, providerOrderId: 'order_' + u };
}

// Provider snapshot as fetched from Razorpay GET /payments/{id}: amount, currency, status, amount_refunded.
export async function apply(q, { providerOrderId, paymentId, amount, status = 'CAPTURED', amountRefunded = 0, actor = 'WEBHOOK', currency = 'INR' }) {
  return val(q, `SELECT aq_apply_provider_payment($1,$2,$3,$4,$5,$6,now(),'upi','{}'::jsonb,$7)`,
    [providerOrderId, paymentId, amount, currency, status, amountRefunded, actor]);
}

export function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }
export function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`ASSERT ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
export async function rejects(p, re, msg) {
  try { await p; } catch (e) { if (re.test(e.message) || re.test(e.code || '')) return e.message; throw new Error(`ASSERT ${msg}: wrong error ${e.code} ${e.message}`); }
  throw new Error(`ASSERT ${msg}: expected rejection`);
}
