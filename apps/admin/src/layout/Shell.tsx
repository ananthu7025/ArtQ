// Admin shell (design-system.md §6.4, product.md §7.2): 248 px ink-900 sidebar whose item list scrolls on its own
// (the header stays fixed), so the lowest item is reachable at any height and at 200 % zoom. Below 1024 px the sidebar
// becomes an off-canvas drawer (Radix Dialog: focus trap, Esc / overlay close, focus returns to the menu button).
import * as Dialog from '@radix-ui/react-dialog';
import { LogOut, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { visibleNav } from '../nav';

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { state } = useAuth();
  const groups = visibleNav(state.status === 'authenticated' ? state.permissions : []);
  return (
    <ul className="space-y-4 px-3 py-4">
      {groups.map((g) => (
        <li key={g.title ?? 'main'}>
          {g.title && <h2 className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{g.title}</h2>}
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex h-10 items-center rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-300 ${
                      isActive ? 'bg-brand-700 font-semibold text-white' : 'text-sidebar-text hover:bg-[#1f2937]'}`}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

const Brand = () => <div className="flex h-16 shrink-0 items-center px-6 font-display text-lg text-white">ArtQ Admin</div>;

export function Shell() {
  const { state, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const user = state.status === 'authenticated' ? state.user : null;

  return (
    <div className="min-h-dvh bg-surface-50 lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <a href="#main" className="sr-only z-50 rounded bg-white px-3 py-2 text-ink-900 focus:not-sr-only focus:fixed focus:left-2 focus:top-2">Skip to content</a>

      <aside className="sticky top-0 hidden h-dvh flex-col bg-ink-900 lg:flex" aria-label="Main navigation" data-testid="sidebar">
        <Brand />
        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Modules" data-testid="sidebar-scroll">
          <NavList />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-surface-200 bg-white px-4 lg:px-8">
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-900 hover:bg-surface-100 lg:hidden" aria-label="Open navigation">
                <Menu aria-hidden size={22} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
              <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(280px,85vw)] flex-col bg-ink-900 outline-none" aria-describedby={undefined} data-testid="drawer">
                <div className="flex shrink-0 items-center justify-between pr-2">
                  <Dialog.Title asChild><div className="flex h-16 items-center px-6 font-display text-lg text-white">ArtQ Admin</div></Dialog.Title>
                  <Dialog.Close className="inline-flex h-11 w-11 items-center justify-center rounded-md text-sidebar-text hover:bg-[#1f2937] focus-visible:ring-2 focus-visible:ring-brand-300" aria-label="Close navigation">
                    <X aria-hidden size={20} />
                  </Dialog.Close>
                </div>
                <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Modules" data-testid="drawer-scroll">
                  <NavList onNavigate={() => setOpen(false)} />
                </nav>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <div className="flex-1" />
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="hidden text-right sm:block">
                <span className="block font-medium text-ink-900">{user.name ?? user.email}</span>
                <span className="block text-xs text-ink-500">{user.role.replace('_', ' ').toLowerCase()}</span>
              </span>
              <button type="button" onClick={() => void logout()} className="inline-flex h-11 items-center gap-2 rounded-md px-3 text-ink-700 hover:bg-surface-100">
                <LogOut aria-hidden size={18} /> <span>Log out</span>
              </button>
            </div>
          )}
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 p-4 outline-none lg:p-8" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
