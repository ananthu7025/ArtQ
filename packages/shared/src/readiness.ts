// Publication gate (product.md §8.7). The checks themselves run in PostgreSQL (`product_readiness_failures`, database.md
// §6a), the single definition used by the publish endpoint, the edit-guard, the nightly check and the trigger backstop.
// This file only names each failure code for people: what is wrong and how to fix it.

export const READINESS = {
  taxonomy: { check: 'Type & category', fix: 'Choose a product type and a category of that type.' },
  no_description: { check: 'Description', fix: 'Write a description for the product.' },
  no_tax: { check: 'Tax classification', fix: 'Enter the HSN code and GST rate and approve them.' },
  has_flags: { check: 'Data flags', fix: 'Resolve the import flags on the product (for example a description copied from elsewhere).' },
  no_image: { check: 'Image', fix: 'Add a cover image and wait until it has finished processing.' },
  no_active_variant: { check: 'Variants', fix: 'Turn on at least one variant.' },
  no_price_or_size: { check: 'Price & size', fix: 'Give every active variant a price and a size with a unit.' },
  stock_uncounted: { check: 'Physical inventory', fix: 'Count the stock of every active variant (Inventory → Recount).' },
  shipping_data: { check: 'Shipping data', fix: 'Enter a measured weight for every active variant, and dimensions for bulky ones.' },
  variant_flags: { check: 'Data flags', fix: 'Resolve the import flags on the variants (for example a missing price or a size conflict).' },
} as const;

export type ReadinessCode = keyof typeof READINESS;
export type ReadinessFailure = { code: string; check: string; fix: string };

/** Describes failure codes in check order; an unknown code is shown as-is rather than dropped. */
export function describeReadiness(codes: readonly string[]): ReadinessFailure[] {
  return codes.map((code) => {
    const r = (READINESS as Record<string, { check: string; fix: string } | undefined>)[code];
    return { code, check: r?.check ?? code, fix: r?.fix ?? 'See the product readiness panel.' };
  });
}
