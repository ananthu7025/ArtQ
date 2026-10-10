// CMS bodies (task 6.1): what the API and the admin forms both enforce, at each boundary.
import { describe, expect, it } from 'vitest';
import { announcementBody, faqBody, heroBody, homeSectionsBody, instagramBody, linkField, messagePatchBody, pageBody, reelBody, slideBody, socialBody, testimonialBody } from './cms-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));

describe('cms schemas', () => {
  it('links: site paths and https only', () => {
    for (const ok of ['/shop', '/type/resins?sort=new', 'https://artq.in/x']) expect(linkField.safeParse(ok).success).toBe(true);
    for (const bad of ['//evil.com', 'http://x.in', 'javascript:alert(1)', 'shop', '/a b']) expect(linkField.safeParse(bad).success).toBe(false);
  });
  it('slides: image required; button text and link together; end after start; empty strings become null', () => {
    expect(issues(slideBody.safeParse({}))).toEqual({ mediaId: 'Choose an image' });
    expect(issues(slideBody.safeParse({ mediaId: 1, ctaLink: '/shop' }))).toEqual({ ctaText: 'A button needs both its text and its link' });
    expect(issues(slideBody.safeParse({ mediaId: 1, startsAt: '2026-10-10T00:00:00Z', endsAt: '2026-10-10T00:00:00Z' }))).toEqual({ endsAt: 'Use an end after the start' });
    expect(slideBody.parse({ mediaId: 1, heading: '  ', ctaLink: '' })).toMatchObject({ heading: null, ctaLink: null, isActive: true });
    expect(slideBody.safeParse({ mediaId: 1, heading: 'x'.repeat(160) }).success).toBe(true);
    expect(issues(slideBody.safeParse({ mediaId: 1, heading: 'x'.repeat(161) }))).toEqual({ heading: 'Use at most 160 characters' });
  });
  it('reels and testimonials', () => {
    expect(issues(reelBody.safeParse({ videoMediaId: 1, instagramUrl: 'https://example.com/r' }))).toEqual({ instagramUrl: 'Use an instagram.com link' });
    expect(reelBody.safeParse({ videoMediaId: 1, instagramUrl: 'https://www.instagram.com/reel/abc/' }).success).toBe(true);
    const t = { name: 'Asha', quote: 'Lovely work, thank you!' };
    expect(testimonialBody.safeParse({ ...t, rating: 1 }).success && testimonialBody.safeParse({ ...t, rating: 5 }).success).toBe(true);
    expect(issues(testimonialBody.safeParse({ ...t, rating: 0 }))).toEqual({ rating: 'Use 1 to 5 stars' });
    expect(issues(testimonialBody.safeParse({ ...t, rating: 3, quote: 'x'.repeat(601) }))).toEqual({ quote: 'Use at most 600 characters' });
  });
  it('faqs and pages', () => {
    expect(Object.keys(issues(faqBody.safeParse({})))).toEqual(['group', 'question', 'answer']);
    expect(issues(faqBody.safeParse({ group: 'ORDERS', question: 'Why?', answer: 'Because.' }))).toEqual({ question: 'Enter the question' });
    expect(pageBody.parse({ slug: ' Care-Guide ', title: 'Care', content: '<p>x</p>' }).slug).toBe('care-guide');
    expect(issues(pageBody.safeParse({ slug: 'care--guide', title: 'Care', content: '<p>x</p>' }))).toEqual({ slug: 'Use lowercase letters, digits and single dashes' });
    expect(pageBody.safeParse({ slug: 'x'.repeat(80), title: 'Care', content: '<p>x</p>' }).success).toBe(true);
    expect(pageBody.safeParse({ slug: 'x'.repeat(81), title: 'Care', content: '<p>x</p>' }).success).toBe(false);
  });
  it('home settings', () => {
    expect(issues(announcementBody.safeParse({ enabled: true, messages: [] }))).toEqual({ messages: 'Add a message, or turn the bar off' });
    expect(announcementBody.safeParse({ enabled: false, messages: [] }).success).toBe(true);
    expect(issues(announcementBody.safeParse({ enabled: true, messages: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toEqual({ messages: 'At most 5 messages' });
    const order = ['hero', 'types', 'new-arrivals', 'reels', 'trending', 'techniques', 'testimonials', 'instagram'];
    expect(homeSectionsBody.safeParse({ order, hidden: ['reels'] }).success).toBe(true);
    expect(issues(homeSectionsBody.safeParse({ order: [...order.slice(1), 'types'], hidden: [] }))).toEqual({ order: 'List every section once' });
    expect(heroBody.safeParse({ slideIntervalMs: 30_000 }).success).toBe(true);
    expect(issues(heroBody.safeParse({ slideIntervalMs: 30_001 }))).toEqual({ slideIntervalMs: 'Use at most 30 seconds' });
    expect(instagramBody.parse({ enabled: false, handle: '' })).toEqual({ enabled: false, handle: null });
    expect(issues(instagramBody.safeParse({ enabled: true, handle: 'bad handle!' }))).toEqual({ handle: 'Use the Instagram handle, e.g. @artq.studio' });
    expect(issues(socialBody.safeParse({ instagram: null, facebook: null, youtube: null, whatsapp: '98470' }))).toEqual({ whatsapp: 'Use the number with country code, e.g. +919847012345' });
  });
  it('message patch needs a change; note limit 2,000', () => {
    expect(messagePatchBody.safeParse({}).success).toBe(false);
    expect(messagePatchBody.parse({ adminNote: '' })).toEqual({ adminNote: null });
    expect(messagePatchBody.safeParse({ adminNote: 'x'.repeat(2001) }).success).toBe(false);
  });
});
