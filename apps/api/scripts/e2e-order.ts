// E2E helper (task 5.1): one placed cash-on-delivery order in the e2e database, made through the real database
// functions (aq_reserve_order, aq_place_cod_order), so the admin Orders e2e has something to confirm, pack and print.
// Prints {"orderNumber": "...", "id": n}.
//   E2E_DATABASE_URL=postgresql://artq:artq@localhost:55432/artq_e2e tsx scripts/e2e-order.ts
// Refuses any database other than artq_e2e (the same guard as e2e-setup.ts).
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as fn from '../src/db/functions.js';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is required');
if (new URL(url).pathname !== '/artq_e2e') throw new Error('refusing: only /artq_e2e may be used');

const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const u = randomBytes(4).toString('hex');
  const out = await prisma.$transaction(async (tx) => {
    const type = await tx.productType.create({ data: { name: `E2E Resins ${u}`, slug: `e2e-resins-${u}` } });
    const category = await tx.category.create({ data: { typeId: type.id, name: `E2E Epoxy ${u}`, slug: `e2e-epoxy-${u}` } });
    const product = await tx.product.create({ data: { typeId: type.id, categoryId: category.id, name: 'E2E Epoxy Resin', slug: `e2e-epoxy-resin-${u}`, description: 'e2e' } });
    const variant = await tx.productVariant.create({ data: { productId: product.id, sku: `E2E-RES-${u}`.toUpperCase(), size: '500 ml', label: '500 ml', price: 49_900, onHand: 20, netQuantity: 500, netUnit: 'ML', weightG: 600 } });
    const kerala = await tx.state.findFirstOrThrow({ where: { name: 'Kerala' } });
    const number = `AQ${Date.now().toString().slice(-8)}`;
    const order = await tx.order.create({ data: {
      orderNumber: number, contactEmail: `e2e-order-${u}@example.com`, contactPhone: '+919847012345', status: 'PENDING_PAYMENT', paymentStatus: 'UNPAID', paymentMethod: 'COD',
      subtotal: 99_800, mrpTotal: 99_800, shippingFee: 7000, codFee: 4000, total: 110_800, actualWeightG: 1350, chargeableWeightG: 1350, pricingSnapshot: {},
      shipName: 'Hema Rajan', shipPhone: '+919847012345', shipLine1: '12 Rose Villa', shipLandmark: 'SBI', shipCity: 'Kochi', shipState: 'Kerala', shipStateCode: kerala.gstCode, shipPincode: '682011',
      customerNote: 'Please call before delivery', trackingTokenHash: randomBytes(32).toString('hex'), placedAt: new Date(),
      items: { create: [{ productId: product.id, variantId: variant.id, productName: product.name, variantLabel: '500 ml', sku: variant.sku, unitPrice: 49_900, quantity: 2, lineTotal: 99_800, discount: 0, netAmount: 99_800, taxRate: 18, taxAmount: 15_224, weightG: 600 }] },
    } });
    await fn.reserveOrder(tx, order.id);
    await fn.placeCodOrder(tx, order.id, 'CUSTOMER');
    return { orderNumber: number, id: order.id };
  });
  console.log(JSON.stringify(out));
} finally {
  await prisma.$disconnect();
}
