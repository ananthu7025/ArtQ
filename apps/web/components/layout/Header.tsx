'use client';
// Header (product.md §4.2, design-system.md §6.1): sticky; on phones it slides away while scrolling down and comes back
// when scrolling up (never while a menu is open or focus is inside it). Desktop (≥ 1024 px): logo · links with the SHOP
// mega-menu (types → categories) · search, login, wishlist, cart. Below 1024 px: ☰ + 🔍 · logo · account, wishlist, cart,
// with the menu in a focus-trapped drawer. Signed in: the first name (desktop) and the 👤 lead to the account.
import type { Navigation } from '@artq/shared';
import { ChevronDown, Heart, Menu, Search, ShoppingBag, User } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { MobileDrawer } from './MobileDrawer';
import { NAV_LINKS } from './links';
import { SearchDialog } from './SearchDialog';
import { useShop } from '../shop/ShopProvider';
import { useAuth } from '../account/AuthProvider';
import type { Customer } from '../../lib/session';

/** The header greets by first name (or "Account" when no name is set). */
const firstName = (u: Customer) => u.name?.trim().split(/\s+/)[0] || 'Account';

// Display is set per use (`inline-flex`, or `hidden lg:inline-flex`): two display classes on one element fight.
const iconBox = 'relative h-11 w-11 items-center justify-center rounded-md text-ink-900 hover:bg-surface-100';
const iconBtn = `inline-flex ${iconBox}`;

export function Logo() {
  return (
    <Link href="/" className="flex flex-col items-center leading-none text-ink-900">
      <span className="font-display text-[22px] font-semibold tracking-[0.25em] md:text-[26px]">ARTQ</span>
      <span className="font-eyebrow mt-0.5 text-[8px] uppercase tracking-[0.3em] text-ink-700 md:text-[9px]">Wood moulds &amp; resins</span>
      <span className="sr-only">, home</span>
    </Link>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <>
      <span aria-hidden className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-700 px-1 text-[11px] font-semibold text-white">{n > 99 ? '99+' : n}</span>
      <span className="sr-only">{label}, {n} {n === 1 ? 'item' : 'items'}</span>
    </>
  );
}

/** Hides the header on phones while scrolling down (product.md §4.2); `pinned` keeps it visible. */
export function useHideOnScroll(pinned: boolean) {
  const [hidden, setHidden] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const mobile = window.innerWidth < 768;
      if (!mobile || pinned || y < 80) setHidden(false);
      else if (y > last.current + 4) setHidden(true);
      else if (y < last.current - 4) setHidden(false);
      last.current = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pinned]);
  return hidden && !pinned;
}

function MegaMenu({ navigation }: { navigation: Navigation }) {
  // Open only on the page it was opened on: following a link closes it without an extra render.
  const pathname = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => setOpenAt((cur) => ((typeof v === 'function' ? v(cur === pathname) : v) ? pathname : null));
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLLIElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A mouse opens the panel on hover; the click that usually follows must not close it again.
  const openedByHover = useRef(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpenAt(null); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  const enter = () => { clearTimeout(closeTimer.current); if (!open) openedByHover.current = true; setOpen(true); };
  const leave = () => { openedByHover.current = false; closeTimer.current = setTimeout(() => setOpen(false), 150); };
  const click = () => { if (openedByHover.current) { openedByHover.current = false; setOpen(true); } else setOpen((o) => !o); };
  return (
    <li ref={root} className="static" onPointerEnter={(e) => { if (e.pointerType === 'mouse') enter(); }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') leave(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}
      onBlur={(e) => { if (!root.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={button} type="button" aria-expanded={open} aria-controls={panelId} onClick={click}
        className="font-eyebrow flex h-11 items-center gap-1 px-3 text-[13px] uppercase tracking-[0.12em] text-ink-900 hover:text-brand-700">
        Shop <ChevronDown aria-hidden size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>
      <div id={panelId} hidden={!open} className="absolute inset-x-0 top-full z-[45] border-t border-surface-200 bg-white shadow-lg">
        <div className="mx-auto max-w-[1320px] px-8 py-6">
          {navigation.types.length === 0
            ? <p className="text-ink-700">Our range is being updated. <Link href="/shop" className="font-medium text-brand-700 underline">See all products</Link></p>
            : (
              <ul className="grid grid-cols-4 gap-x-8 gap-y-6 xl:grid-cols-5">
                {navigation.types.map((t) => (
                  <li key={t.id}>
                    <Link href={t.href} className="font-display text-[17px] font-semibold text-ink-900 hover:text-brand-700">{t.name}</Link>
                    {t.categories.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {t.categories.map((c) => <li key={c.id}><Link href={`/category/${c.slug}`} className="text-sm text-ink-700 hover:text-brand-700 hover:underline">{c.name}</Link></li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          <Link href="/shop" className="mt-6 inline-block text-sm font-semibold uppercase tracking-[0.06em] text-brand-700 underline">Shop all products</Link>
        </div>
      </div>
    </li>
  );
}

export function Header({ navigation, cartCount, wishlistCount }: { navigation: Navigation; cartCount?: number; wishlistCount?: number }) {
  const shop = useShop();
  const { user } = useAuth();
  cartCount ??= shop.cartCount;
  wishlistCount ??= shop.wishlist.length;
  const pathname = usePathname();
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawer = drawerAt === pathname;   // closes by itself when a link in it changes the page
  const setDrawer = (o: boolean) => setDrawerAt(o ? pathname : null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const searchButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const searchOpener = useRef<HTMLButtonElement | null>(null);
  const openSearch = (i: number) => { searchOpener.current = searchButtons.current[i] ?? null; setSearch(true); };
  const [search, setSearch] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const hidden = useHideOnScroll(drawer || search || focusInside);
  const link = (href: string) => (pathname === href ? 'page' as const : undefined);

  return (
    <header data-hidden={hidden || undefined} onFocus={() => setFocusInside(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocusInside(false); }}
      className="sticky top-0 z-40 border-b border-surface-200 bg-white transition-transform duration-200 data-[hidden]:-translate-y-full motion-reduce:transition-none">
      <div className="relative mx-auto grid h-[60px] max-w-[1320px] grid-cols-[1fr_auto_1fr] items-center px-4 md:px-6 lg:flex lg:h-[72px] lg:gap-6 lg:px-8">
        {/* Phones and tablets: ☰ 🔍 | logo | 👤 ♡ 🛒 */}
        <div className="flex items-center lg:hidden">
          <button ref={menuButton} type="button" className={iconBtn} onClick={() => setDrawer(true)} aria-label="Open menu"><Menu aria-hidden size={22} strokeWidth={1.75} /></button>
          <button ref={(el) => { searchButtons.current[0] = el; }} type="button" className={iconBtn} onClick={() => openSearch(0)} aria-label="Search"><Search aria-hidden size={22} strokeWidth={1.75} /></button>
        </div>
        <div className="justify-self-center lg:justify-self-auto"><Logo /></div>

        <nav aria-label="Main" className="hidden flex-1 justify-center lg:flex">
          <ul className="flex items-center">
            <li><Link href="/" aria-current={link('/')} className="font-eyebrow flex h-11 items-center px-3 text-[13px] uppercase tracking-[0.12em] text-ink-900 hover:text-brand-700 aria-[current=page]:text-brand-700">Home</Link></li>
            <MegaMenu navigation={navigation} />
            {NAV_LINKS.slice(1).map((l) => (
              <li key={l.href}><Link href={l.href} aria-current={link(l.href)} className="font-eyebrow flex h-11 items-center px-3 text-[13px] uppercase tracking-[0.12em] text-ink-900 hover:text-brand-700 aria-[current=page]:text-brand-700">{l.label}</Link></li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center justify-self-end">
          <button ref={(el) => { searchButtons.current[1] = el; }} type="button" className={`hidden lg:inline-flex ${iconBox}`} onClick={() => openSearch(1)} aria-label="Search"><Search aria-hidden size={22} strokeWidth={1.75} /></button>
          <Link href={user ? '/account' : '/login'} className={`inline-flex lg:hidden ${iconBox}`} aria-label={user ? 'Your account' : 'Log in or sign up'}><User aria-hidden size={22} strokeWidth={1.75} /></Link>
          {user
            ? <Link href="/account" aria-label="Your account" className="font-eyebrow hidden h-11 max-w-[180px] items-center gap-2 px-3 text-[13px] uppercase tracking-[0.12em] text-ink-900 hover:text-brand-700 lg:inline-flex"><User aria-hidden size={18} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{firstName(user)}</span></Link>
            : <Link href="/login" className="font-eyebrow hidden h-11 items-center whitespace-nowrap px-3 text-[13px] uppercase tracking-[0.12em] text-ink-900 hover:text-brand-700 lg:inline-flex">Login / Sign up</Link>}
          <Link href="/wishlist" className={iconBtn}><Heart aria-hidden size={22} strokeWidth={1.75} /><Count n={wishlistCount} label="Wishlist" /></Link>
          <Link href="/cart" className={iconBtn}><ShoppingBag aria-hidden size={22} strokeWidth={1.75} /><Count n={cartCount} label="Cart" /></Link>
        </div>
      </div>
      <MobileDrawer open={drawer} onOpenChange={setDrawer} navigation={navigation} returnFocus={() => menuButton.current?.focus()} />
      <SearchDialog open={search} onOpenChange={setSearch} returnFocus={() => searchOpener.current?.focus()} />
    </header>
  );
}
