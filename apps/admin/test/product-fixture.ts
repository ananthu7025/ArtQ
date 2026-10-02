// A full editor payload (GET /admin/products/:id) for UI tests: "Teak Wood Frame" with two variants and one image.
import type { ProductPayload } from '../src/pages/products/editor/schema';

export function teakFrame(over: Partial<ProductPayload> = {}): ProductPayload {
  return {
    id: 1, status: 'DRAFT', name: 'Teak Wood Frame', slug: 'teak-wood-frame', shortDescription: 'Teak frames with a plywood base.',
    description: '<p>Teak wood frames with plywood base.</p>', productDetails: ['Teak wood frame', 'Plywood base'], specificationsCare: ['Keep dry'],
    howToUse: null, specifications: { Material: 'Teak' }, tags: ['frames'], type: { id: 2, name: 'Frames' }, category: { id: 20, name: 'Teak' },
    techniqueIds: [1], hsnCode: null, gstRate: null, taxApprovedAt: null, isNewArrival: false, newArrivalRank: null, isTrending: false,
    trendingRank: null, isFeatured: false, sortOrder: 0, metaTitle: null, metaDescription: null, dataFlags: ['STOCK_AMBIGUOUS'],
    aggregates: { minPrice: 21_000, maxPrice: 29_900, maxMrp: null, available: 0, activeVariants: 2 },
    variants: [
      { id: 11, sku: 'TWF-1IN-4X6', label: '4×6 in / 1 inch', size: '4×6 in', netQuantity: 1, netUnit: 'PCS', color: null, colorHex: null, thickness: '1 inch', weightG: null, weightSource: null, lengthCm: null, widthCm: null, heightCm: null, shippingClass: 'STANDARD', imageMediaId: null, barcode: null, sortOrder: 0, isActive: true, price: 21_000, mrp: null, costPrice: 12_000, onHand: 0, reserved: 0, available: 0, dataFlags: [], version: 2 },
      { id: 12, sku: 'TWF-1IN-6X6', label: '6×6 in / 1 inch', size: '6×6 in', netQuantity: 1, netUnit: 'PCS', color: null, colorHex: null, thickness: '1 inch', weightG: null, weightSource: null, lengthCm: null, widthCm: null, heightCm: null, shippingClass: 'STANDARD', imageMediaId: null, barcode: null, sortOrder: 1, isActive: true, price: 29_900, mrp: null, costPrice: null, onHand: 0, reserved: 0, available: 0, dataFlags: [], version: 2 },
    ],
    images: [{ id: 1, mediaId: 101, alt: 'Front', sortOrder: 0, isCover: true, media: { id: 101, status: 'READY', renditions: { 160: 'https://cdn.test/101-160.webp' } } }],
    relations: [],
    readiness: { ready: false, failures: [{ code: 'no_tax', check: 'Tax classification', fix: 'Enter the HSN code and GST rate and approve them.' }, { code: 'stock_uncounted', check: 'Physical inventory', fix: 'Count the stock of every active variant (Inventory → Recount).' }] },
    version: 5, updatedAt: '2026-10-02T10:42:00Z', updatedBy: { id: 9, name: 'Anu', email: 'anu@artq.in' },
    ...over,
  };
}

export const TECHNIQUES = { data: [{ id: 1, name: 'Photo Framing', slug: 'photo-framing', isActive: true }, { id: 2, name: 'Resin Art', slug: 'resin-art', isActive: true }] };
