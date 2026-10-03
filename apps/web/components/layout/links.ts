// Fixed storefront links (product.md §3, §4.2, §4.3). Types and categories come from GET /v1/navigation.
export const NAV_LINKS = [
  { label: 'Home', href: '/' },
  { label: 'Shop all', href: '/shop' },
  { label: 'New arrivals', href: '/new-arrivals' },
  { label: 'About us', href: '/about' },
  { label: 'Contact', href: '/contact' },
] as const;

export const POLICY_LINKS = [
  { label: 'Terms & Conditions', href: '/terms' },
  { label: 'Privacy Policy', href: '/privacy-policy' },
  { label: 'Shipping Policy', href: '/shipping-policy' },
  { label: 'Return & Refund Policy', href: '/return-policy' },
  { label: 'Cancellation Policy', href: '/cancellation-policy' },
] as const;

export const PAYMENT_METHODS = ['UPI', 'Visa', 'Mastercard', 'RuPay', 'Net banking', 'Cash on delivery'] as const;
