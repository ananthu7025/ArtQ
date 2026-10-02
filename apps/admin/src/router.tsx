import { Navigate, Outlet, useLocation, type RouteObject } from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { Shell } from './layout/Shell';
import { ALL_NAV_ITEMS, canSee, type NavItem } from './nav';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { LoginPage } from './pages/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordPages';
import { StaffPage } from './pages/StaffPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { ProductSummaryPage } from './pages/products/ProductSummaryPage';
import { DashboardPage, ForbiddenPage, FullPageSpinner, ModulePlaceholder, NotFoundPage } from './pages/simple';

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
const BUILT: Record<string, () => React.ReactNode> = {
  '/dashboard': () => <DashboardPage />,
  '/audit-logs': () => <AuditLogsPage />,
  '/staff': () => <StaffPage />,
  '/products': () => <ProductsPage />,
};
const PRODUCTS = ALL_NAV_ITEMS.find((i) => i.path === '/products')!;

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
        { path: '/products/:id', element: <Guard item={PRODUCTS}><ProductSummaryPage /></Guard> },
        { path: '*', element: <NotFoundPage /> },
      ],
    }],
  },
];
