import { Link } from 'react-router';
import type { NavItem } from '../nav';

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-display text-2xl text-ink-900">{title}</h1>
      {children}
    </div>
  );
}

export function ModulePlaceholder({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} />
      <div className="rounded-lg border border-dashed border-border-input bg-white p-8 text-center text-ink-700">
        <p className="font-medium text-ink-900">Not built yet</p>
        <p className="mt-1 text-sm">This module is delivered by task {item.task} (docs/tasklist.md).</p>
      </div>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p className="text-ink-700">That page does not exist. <Link className="text-brand-700 underline" to="/dashboard">Go to the dashboard</Link>.</p>
    </>
  );
}

export function ForbiddenPage() {
  return (
    <>
      <PageHeader title="No access" />
      <p className="text-ink-700">Your role cannot open this module. Ask a Super Admin if you need it.</p>
    </>
  );
}

export function FullPageSpinner() {
  return <div className="flex min-h-dvh items-center justify-center text-ink-700" role="status">Loading…</div>;
}
