// Admin dashboard (task 5.9; api.md §4.2, product.md §7.5) [dashboard:read]. Figures for today / 7 / 30 India calendar
// days: revenue (placed orders that were not cancelled, after refunds), orders, average order value, new customers, a
// sales series (hourly today, daily otherwise), orders by status; what is waiting for staff; low stock; top products.
// Read-only aggregate queries; the date range is computed in India time (UTC+5:30, no daylight saving).
import { COD_OVERDUE_DAYS, type Dashboard, type DASHBOARD_RANGES } from '@artq/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

const IST_MS = 5.5 * 3_600_000;
type Range = (typeof DASHBOARD_RANGES)[number];

/** [from, to) of the range in UTC, and the bucket ('hour' today, 'day' otherwise). */
export function rangeBounds(range: Range, now = new Date()): { from: Date; to: Date; bucket: 'hour' | 'day'; days: number } {
  const ist = new Date(now.getTime() + IST_MS);
  const startOfTodayIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS;
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  return { from: new Date(startOfTodayIst - (days - 1) * 86_400_000), to: new Date(startOfTodayIst + 86_400_000), bucket: range === 'today' ? 'hour' : 'day', days };
}

/** Counted as sales: placed and not cancelled (COD counts when placed). */
const SOLD = Prisma.sql`o.status IN ('PLACED', 'CONFIRMED', 'COMPLETED')`;

export class DashboardService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(range: Range, now = new Date()): Promise<Dashboard> {
    const { from, to, bucket, days } = rangeBounds(range, now);
    const placedIn = Prisma.sql`o.placed_at >= ${from} AND o.placed_at < ${to}`;
    const [totals, series, byStatus, newCustomers, pending, lowStock, top] = await Promise.all([
      this.prisma.$queryRaw<{ revenue: bigint | null; orders: number }[]>`
        SELECT sum(o.total - o.refunded_amount) AS revenue, count(*)::int AS orders FROM orders o WHERE ${placedIn} AND ${SOLD}`,
      this.prisma.$queryRaw<{ k: string; revenue: bigint | null; orders: number }[]>`
        SELECT to_char(date_trunc(${bucket}, o.placed_at AT TIME ZONE 'Asia/Kolkata'), ${bucket === 'hour' ? 'HH24:00' : 'YYYY-MM-DD'}) AS k,
               sum(o.total - o.refunded_amount) AS revenue, count(*)::int AS orders
          FROM orders o WHERE ${placedIn} AND ${SOLD} GROUP BY 1`,
      this.prisma.$queryRaw<{ status: string; n: number }[]>`SELECT o.status::text, count(*)::int AS n FROM orders o WHERE ${placedIn} GROUP BY 1`,
      this.prisma.user.count({ where: { role: 'CUSTOMER', deletedAt: null, createdAt: { gte: from, lt: to } } }),
      this.prisma.$queryRaw<Dashboard['pendingActions'][]>`SELECT
          (SELECT count(*)::int FROM orders WHERE status = 'PLACED' AND payment_status IN ('PAID', 'COD_PENDING')) AS "toConfirm",
          (SELECT count(*)::int FROM orders WHERE status = 'CONFIRMED' AND fulfilment_status = 'UNFULFILLED') AS "toPack",
          (SELECT count(*)::int FROM orders WHERE status = 'CONFIRMED' AND fulfilment_status = 'PACKED') AS "toShip",
          (SELECT count(*)::int FROM return_requests WHERE status = 'REQUESTED') AS "returnsToDecide",
          (SELECT count(*)::int FROM payment_exceptions WHERE status IN ('OPEN', 'AUTO_RESOLVING')) AS "openExceptions",
          (SELECT count(*)::int FROM stock_notifications WHERE status = 'PENDING') AS "restockRequests",
          (SELECT count(*)::int FROM orders o JOIN shipments s ON s.order_id = o.id WHERE o.payment_method = 'COD' AND o.fulfilment_status = 'DELIVERED'
              AND o.payment_status IN ('COD_COLLECTED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND s.delivered_at < now() - make_interval(days => ${COD_OVERDUE_DAYS}::int)
              AND NOT EXISTS (SELECT 1 FROM cod_remittance_items c WHERE c.order_id = o.id)) AS "codOverdue",
          NULL::int AS messages`,
      this.prisma.$queryRaw<{ variant_id: number; product_id: number; name: string; label: string; sku: string; available: number; threshold: number }[]>`
        SELECT v.id AS variant_id, p.id AS product_id, p.name, coalesce(v.label, v.size, '') AS label, v.sku, (v.on_hand - v.reserved)::int AS available, v.low_stock_threshold AS threshold
          FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE p.status = 'ACTIVE' AND v.is_active AND v.on_hand - v.reserved <= v.low_stock_threshold
         ORDER BY v.on_hand - v.reserved, p.name LIMIT 10`,
      this.prisma.$queryRaw<{ product_id: number | null; name: string; units: number; revenue: bigint }[]>`
        SELECT i.product_id, min(i.product_name) AS name, sum(i.quantity - i.refunded_qty)::int AS units, sum(i.net_amount - i.refunded_amount) AS revenue
          FROM order_items i JOIN orders o ON o.id = i.order_id WHERE ${placedIn} AND ${SOLD}
         GROUP BY i.product_id ORDER BY units DESC, revenue DESC LIMIT 5`,
    ]);
    const revenue = Number(totals[0]?.revenue ?? 0);
    const orders = totals[0]?.orders ?? 0;
    const byKey = new Map(series.map((r) => [r.k, r]));
    const labels = bucket === 'hour'
      ? Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
      : Array.from({ length: days }, (_, i) => new Date(from.getTime() + IST_MS + i * 86_400_000).toISOString().slice(0, 10));
    return {
      range, revenue, orders, aov: orders ? Math.round(revenue / orders) : 0, newCustomers,
      salesSeries: labels.map((label) => ({ label, revenue: Number(byKey.get(label)?.revenue ?? 0), orders: byKey.get(label)?.orders ?? 0 })),
      ordersByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      pendingActions: pending[0]!,
      lowStock: lowStock.map((v) => ({ variantId: v.variant_id, productId: v.product_id, productName: v.name, label: v.label, sku: v.sku, available: v.available, threshold: v.threshold })),
      topProducts: top.map((t) => ({ productId: t.product_id, name: t.name, units: t.units, revenue: Number(t.revenue) })),
    };
  }
}
