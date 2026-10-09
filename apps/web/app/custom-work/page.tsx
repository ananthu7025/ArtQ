// Custom work (task 6.2; persona "Preservation Priya"): flower and garland preservation, frames and made-to-order resin
// pieces. The request (with up to 4 private photos) lands in the admin inbox; the visitor gets an acknowledgement.
import type { Metadata } from 'next';
import { CustomWorkForm } from '../../components/content/forms';

export const metadata: Metadata = { title: 'Custom work', description: 'Preserve wedding flowers and garlands, or order a resin piece made for you.', alternates: { canonical: '/custom-work' } };

export default function CustomWorkPage() {
  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-10 px-4 py-10 md:grid-cols-[1fr_2fr] md:px-6 md:py-14">
      <div>
        <h1 className="font-display text-[28px] font-semibold text-ink-900 md:text-[36px]">Custom work</h1>
        <p className="mt-3 text-ink-700">Wedding garlands and flowers preserved in resin, family keepsakes, frames in teak or double glass, or a piece made to your size.</p>
        <ol className="mt-6 list-decimal space-y-2 pl-5 text-ink-800">
          <li>Tell us what you have in mind, and add photos if you can.</li>
          <li>We reply with options, timing and a price.</li>
          <li>Once you’re happy, we make it and ship it to you.</li>
        </ol>
      </div>
      <CustomWorkForm />
    </div>
  );
}
