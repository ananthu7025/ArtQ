// CMS & Messages (task 6.1; product.md §7.5) [content:write]. One page, one tab per kind of content (the tab is in the
// URL, `?tab=`): hero slides, reels, testimonials, FAQs, pages, home settings and the messages inbox.
import { useSearchParams } from 'react-router';
import { PageHeader } from '../simple';
import { FaqsTab, ReelsTab, SlidesTab, TestimonialsTab } from './content';
import { MessagesTab } from './messages';
import { HomeSettingsTab, PagesTab } from './pages-settings';

const TABS = [
  { key: 'slides', label: 'Hero slides', view: () => <SlidesTab /> },
  { key: 'reels', label: 'Reels', view: () => <ReelsTab /> },
  { key: 'testimonials', label: 'Testimonials', view: () => <TestimonialsTab /> },
  { key: 'faqs', label: 'FAQs', view: () => <FaqsTab /> },
  { key: 'pages', label: 'Pages', view: () => <PagesTab /> },
  { key: 'home', label: 'Home & announcement', view: () => <HomeSettingsTab /> },
  { key: 'messages', label: 'Messages', view: () => <MessagesTab /> },
] as const;

export function CmsPage() {
  const [sp, setSp] = useSearchParams();
  const current = TABS.find((t) => t.key === sp.get('tab')) ?? TABS[0];
  return (
    <>
      <PageHeader title="CMS & Messages" />
      <div role="tablist" aria-label="Content" className="mb-5 flex flex-wrap border-b border-surface-200">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === current.key} onClick={() => setSp(t.key === 'slides' ? new URLSearchParams() : new URLSearchParams({ tab: t.key }))}
            className={`inline-flex h-11 items-center border-b-2 px-4 font-medium ${t.key === current.key ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-700 hover:text-ink-900'}`}>{t.label}</button>
        ))}
      </div>
      <div role="tabpanel" aria-label={current.label}>{current.view()}</div>
    </>
  );
}
