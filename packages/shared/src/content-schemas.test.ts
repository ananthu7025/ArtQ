// Contact and custom-work bodies (task 6.2).
import { describe, expect, it } from 'vitest';
import { contactBody, customWorkBody } from './content-schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]));
const contact = { name: 'Asha', email: 'asha@example.com', subject: 'Order', message: 'Where is my parcel?' };
const work = { name: 'Ravi', email: 'ravi@example.com', phone: '+919847012345', details: {}, message: 'A garland in a teak frame' };

describe('content schemas', () => {
  it('contact: optional phone and order number normalised; message 10–3,000', () => {
    expect(contactBody.parse({ ...contact, phone: '', orderNumber: 'aq10234' })).toMatchObject({ phone: null, orderNumber: 'AQ10234' });
    expect(issues(contactBody.safeParse({ ...contact, message: 'too short' }))).toEqual({ message: 'Write your message (at least 10 characters)' });
    expect(contactBody.safeParse({ ...contact, message: 'x'.repeat(3000) }).success).toBe(true);
    expect(issues(contactBody.safeParse({ ...contact, message: 'x'.repeat(3001) }))).toEqual({ message: 'Use at most 3,000 characters' });
    expect(issues(contactBody.safeParse({ ...contact, orderNumber: 'ORDER1' }))).toEqual({ orderNumber: 'Enter an order number like AQ10234' });
    expect(contactBody.safeParse({ ...contact, extra: 1 }).success).toBe(false);
  });
  it('custom work: phone required; details optional with bounds; at most 4 photos, each once', () => {
    expect(customWorkBody.parse(work)).toMatchObject({ details: { size: null, wood: null, quantity: null, budget: null, neededBy: null }, attachmentMediaIds: [] });
    expect(issues(customWorkBody.safeParse({ ...work, phone: undefined }))).toHaveProperty('phone');
    expect(issues(customWorkBody.safeParse({ ...work, details: { quantity: 0 } }))).toEqual({ 'details.quantity': 'At least 1' });
    expect(customWorkBody.safeParse({ ...work, details: { quantity: 500, budget: 100 } }).success).toBe(true);
    expect(issues(customWorkBody.safeParse({ ...work, details: { quantity: 501 } }))).toEqual({ 'details.quantity': 'At most 500' });
    expect(issues(customWorkBody.safeParse({ ...work, details: { neededBy: '1/12/2026' } }))).toEqual({ 'details.neededBy': 'Use a date like 2026-12-01' });
    expect(customWorkBody.safeParse({ ...work, attachmentMediaIds: [1, 2, 3, 4] }).success).toBe(true);
    expect(issues(customWorkBody.safeParse({ ...work, attachmentMediaIds: [1, 2, 3, 4, 5] }))).toEqual({ attachmentMediaIds: 'At most 4 photos' });
    expect(issues(customWorkBody.safeParse({ ...work, attachmentMediaIds: [1, 1] }))).toEqual({ attachmentMediaIds: 'Each photo only once' });
  });
});
