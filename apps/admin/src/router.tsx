import { Navigate, Outlet, useLocation, type RouteObject } from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { Shell } from './layout/Shell';
import { ALL_NAV_ITEMS, canSee, type NavItem } from './nav';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { LoginPage } from './pages/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordPages';
import { StaffPage } from './pages/StaffPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { TaxonomyPage } from './pages/taxonomy/TaxonomyPage';
import { ImportDetailPage } from './pages/imports/ImportDetailPage';
import { ImportsPage } from './pages/imports/ImportsPage';
import { InventoryPage } from './pages/inventory/InventoryPage';
import { CouponEditorPage } from './pages/coupons/CouponEditorPage';
import { CouponsPage } from './pages/coupons/CouponsPage';
import { ShippingPage } from './pages/shipping/ShippingPage';
import { OrderDetailPage } from './pages/orders/OrderDetailPage';
import { OrdersPage } from './pages/orders/OrdersPage';
import { RefundsPage } from './pages/orders/RefundsPage';
import { CodRemittancesPage } from './pages/cod/CodRemittancesPage';
import { JobsPage } from './pages/ops/JobsPage';
import { CmsPage } from './pages/cms/CmsPage';
import { CustomerDetailPage, CustomersPage } from './pages/customers/CustomersPage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { RestockRequestsPage } from './pages/restock/RestockRequestsPage';
import { PaymentExceptionsPage } from './pages/ops/PaymentExceptionsPage';
import { ReturnDetailPage } from './pages/returns/ReturnDetailPage';
import { ProductEditorPage } from './pages/products/editor/ProductEditorPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { ForbiddenPage, FullPageSpinner, ModulePlaceholder, NotFoundPage } from './pages/simple';

function RequireSession() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullPageSpinner />;
  if (state.status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

function Guard({ item, children }: { item: NavItem; children: React.ReactNode }) {
  const { state } = useAuth();
  return state.status === 'authenticated' && canSee(item, state.permissions) ? <>{children}</> : <ForbiddenPage />;
}

/** Modules built so far; everything else renders its placeholder. */
export const BUILT: Record<string, () => React.ReactNode> = {
  '/dashboard': () => <DashboardPage />,
  '/audit-logs': () => <AuditLogsPage />,
  '/settings': () => <SettingsPage />,
  '/staff': () => <StaffPage />,
  '/products': () => <ProductsPage />,
  '/product-types': () => <TaxonomyPage key="type" kind="type" />,
  '/categories': () => <TaxonomyPage key="category" kind="category" />,
  '/techniques': () => <TaxonomyPage key="technique" kind="technique" />,
  '/imports': () => <ImportsPage />,
  '/inventory': () => <InventoryPage />,
  '/coupons': () => <CouponsPage />,
  '/shipping-rates': () => <ShippingPage />,
  '/orders': () => <OrdersPage />,
  '/returns': () => <RefundsPage />,
  '/cod-remittances': () => <CodRemittancesPage />,
  '/payment-exceptions': () => <PaymentExceptionsPage />,
  '/jobs': () => <JobsPage />,
  '/cms': () => <CmsPage />,
  '/customers': () => <CustomersPage />,
  '/restock-requests': () => <RestockRequestsPage />,
};
const PRODUCTS = ALL_NAV_ITEMS.find((i) => i.path === '/products')!;
const IMPORTS = ALL_NAV_ITEMS.find((i) => i.path === '/imports')!;
const COUPONS = ALL_NAV_ITEMS.find((i) => i.path === '/coupons')!;
const ORDERS = ALL_NAV_ITEMS.find((i) => i.path === '/orders')!;
const RETURNS = ALL_NAV_ITEMS.find((i) => i.path === '/returns')!;
const CUSTOMERS = ALL_NAV_ITEMS.find((i) => i.path === '/customers')!;

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    element: <RequireSession />,
    children: [{
      element: <Shell />,
      children: [
        { index: true, element: <Navigate to="/dashboard" replace /> },
        ...ALL_NAV_ITEMS.map((item) => ({ path: item.path, element: <Guard item={item}>{BUILT[item.path]?.() ?? <ModulePlaceholder item={item} />}</Guard> })),
        { path: '/products/:id', element: <Guard item={PRODUCTS}><ProductEditorPage /></Guard> },
        { path: '/imports/:id', element: <Guard item={IMPORTS}><ImportDetailPage /></Guard> },
        { path: '/coupons/:id', element: <Guard item={COUPONS}><CouponEditorPage /></Guard> },
        { path: '/orders/:id', element: <Guard item={ORDERS}><OrderDetailPage /></Guard> },
        { path: '/returns/:id', element: <Guard item={RETURNS}><ReturnDetailPage /></Guard> },
        { path: '/customers/:id', element: <Guard item={CUSTOMERS}><CustomerDetailPage /></Guard> },
        { path: '*', element: <NotFoundPage /> },
      ],
    }],
  },
];
