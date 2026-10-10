// Task 5.4: refunds in the admin against a fake API. The refund dialog (what is left per item / shipping / COD fee,
// rupees → paise, the shared rules under each field, one Idempotency-Key, a capacity refusal explained and reloaded,
// COD not collected → the reason), an order's refunds (retry, record a bank transfer, cancel) and the refund queue.
import { permissionsFor, type AdminOrderDetail, type AdminRefundRow, type RefundableView } from '@artq/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AdminApi } from '../src/api/client';
import { App } from '../src/App';
import { expectFieldError } from './field';
import { err, fakeServer, type Handler } from './fake-server';

const order = (o: Partial<AdminOrderDetail> = {}): AdminOrderDetail => ({
  id: 7, orderNumber: 'AQ10234', createdAt: '2026-10-05T06:30:00Z', placedAt: '2026-10-05T06:31:00Z',
  customer: { name: 'Hema Rajan', email: 'hema@example.com', phone: '+919847012345', city: 'Kochi', pincode: '682011', isGuest: true },
  itemCount: 2, total: 107_000, paymentMethod: 'RAZORPAY', status: 'CONFIRMED', paymentStatus: 'PAID', fulfilmentStatus: 'DELIVERED', returnStatus: 'NONE', hasOpenException: false,
  version: 3, contactMasked: false, contactEmailVerified: false, userId: null,
  shippingAddress: { fullName: 'Hema Rajan', phone: '+919847012345', line1: '12 Rose Villa', line2: null, landmark: null, city: 'Kochi', state: 'Kerala', stateId: 32, pincode: '682011' },
  billing: { sameAsShipping: true, address: null, gstin: null, businessName: null },
  items: [{ id: 1, productId: 11, variantId: 101, name: 'Epoxy Resin', label: '500 ml', sku: 'RES-500', imageUrl: null, unitPrice: 50_000, quantity: 2, lineTotal: 100_000, discount: 0, netAmount: 100_000, taxRate: 18, taxAmount: 15_254, refundedQty: 0, returnedQty: 0 }],
  totals: { subtotal: 100_000, mrpTotal: 100_000, couponDiscount: 0, couponCode: null, shippingFee: 7000, codFee: 0, total: 107_000, taxTotal: 15_254, capturedAmount: 107_000, refundedAmount: 0 },
  weights: { actualG: 1150, chargeableG: 1150 }, notes: { customer: null, admin: null },
  times: { expiresAt: null, confirmedAt: null, completedAt: null, cancelledAt: null, expiredAt: null, cancelReason: null },
  attempts: [], payments: [], refunds: [], exceptions: [], shipment: null, invoices: [], returns: [], history: [], emails: [], actions: [], resendable: [], ...o,
});
const refundable = (o: Partial<RefundableView> = {}): RefundableView => ({
  orderId: 7, orderNumber: 'AQ10234', method: 'ORIGINAL_PAYMENT', blockedReason: null,
  items: [{ orderItemId: 1, name: 'Epoxy Resin', label: '500 ml', quantity: 2, netAmount: 100_000, reservedQty: 0, reservedAmount: 10_000, refundedQty: 0, refundedAmount: 10_000, availableQty: 2, availableAmount: 90_000 }],
  shipping: { fee: 7000, reserved: 0, available: 7000 }, codFee: { fee: 0, reserved: 0, available: 0 },
  total: { cap: 107_000, reserved: 10_000, refunded: 10_000, available: 97_000 },
  payment: { amount: 107_000, reserved: 10_000, refunded: 10_000, providerRefunded: 10_000, available: 97_000, reconciliationRequired: false }, ...o,
});
const refund = (o: Partial<AdminRefundRow> = {}): AdminRefundRow => ({
  id: 41, orderId: 7, orderNumber: 'AQ10234', kind: 'GOODWILL', method: 'ORIGINAL_PAYMENT', status: 'FAILED', amount: 7000, itemsAmount: 0, shippingAmount: 7000, codFeeAmount: 0,
  reason: 'Late delivery', failureReason: 'The refund amount provided is greater than amount captured', manualReference: null, createdAt: '2026-10-06T06:00:00Z', sentAt: null, processedAt: null,
  attempts: [{ no: 1, key: 'artq-refund-41-a1', receipt: 'AQR_41_A1', status: 'FAILED', lastHttpStatus: 400, sendCount: 1 }], actions: ['retry'], ...o,
});
const page = <T,>(rows: T[]) => [200, { data: rows, meta: { page: 1, limit: 25, total: rows.length, totalPages: 1 } }] as [number, unknown];

function setup(path: string, extra: Record<string, Handler> = {}) {
  const s = fakeServer({
    'POST /admin/auth/refresh': () => [200, { accessToken: 'tok', user: { id: 1, name: 'Anu', email: 'anu@artq.in', role: 'ADMIN' } }],
    'GET /admin/me': () => [200, { user: { id: 1, name: 'Anu', email: 'anu@artq.in', role: 'ADMIN' }, permissions: permissionsFor('ADMIN') }],
    'GET /admin/orders/7': () => [200, order()],
    'GET /admin/refunds': () => page([]),
    'GET /admin/orders/7/refundable': () => [200, refundable()],
    ...extra,
  });
  window.history.replaceState({}, '', path);
  const api = new AdminApi({ baseUrl: 'http://api.test/v1', fetchImpl: s.fetchImpl, locks: null, channel: null });
  return { ...render(<App api={api} />), server: s };
}
const sent = (s: ReturnType<typeof setup>['server'], method: string, path: string) => s.calls.filter((c) => c.method === method && c.path === path);

describe('refund dialog', () => {
  it('rupees → paise, only the filled items; the shared rules under each field; one key per dialog; a capacity refusal explained and reloaded', async () => {
    const u = userEvent.setup();
    let reply: [number, unknown] = err(409, 'REFUND_EXCEEDS_CAPACITY', 'This refunds more than is left to refund on an item (pending refunds count too). Reload to see what is left.', { scope: 'item', orderItemId: 1 });
    const { container, server } = setup('/orders/7', { 'POST /admin/orders/7/refunds': () => reply });
    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Refund' }));
    expect(await dialog.findByText('₹900')).toBeTruthy();                      // left on the item (₹100 already refunded)
    await axe.run(container).then((r) => expect(r.violations.filter((v) => v.id !== 'color-contrast').map((v) => v.id)).toEqual([]));
    await u.click(dialog.getByRole('button', { name: /^Refund ₹0$/ }));
    await waitFor(() => expectFieldError('Reason (kept on the refund)', 'Say why you are refunding', dialog));
    expect(dialog.getByText('Enter an amount to refund')).toBeTruthy();
    await u.type(dialog.getByLabelText('Amount: Epoxy Resin'), '12.345');
    await u.type(dialog.getByLabelText('Units back: Epoxy Resin'), '1.5');
    await u.click(dialog.getByRole('button', { name: /^Refund/ }));
    await waitFor(() => expectFieldError('Amount: Epoxy Resin', 'Use rupees with at most two decimals, e.g. 150 or 99.50', dialog));
    expectFieldError('Units back: Epoxy Resin', 'Use whole units', dialog);
    expect(sent(server, 'POST', '/admin/orders/7/refunds')).toHaveLength(0);
    await u.clear(dialog.getByLabelText('Amount: Epoxy Resin'));
    await u.type(dialog.getByLabelText('Amount: Epoxy Resin'), '500');
    await u.clear(dialog.getByLabelText('Units back: Epoxy Resin'));
    await u.type(dialog.getByLabelText('Units back: Epoxy Resin'), '1');
    await u.type(dialog.getByLabelText('Shipping (₹, up to 70)'), '70');
    await u.type(dialog.getByLabelText('Reason (kept on the refund)'), 'Lid was scratched');
    await u.click(dialog.getByRole('button', { name: 'Refund ₹570' }));
    expect(await dialog.findByText(/more than is left to refund on an item/)).toBeTruthy();
    await waitFor(() => expect(sent(server, 'GET', '/admin/orders/7/refundable').length).toBeGreaterThan(1));
    reply = [201, { refundId: 42, method: 'ORIGINAL_PAYMENT', status: 'REQUESTED', attempt: { no: 1, receipt: 'AQR_42_A1' } }];
    await u.click(dialog.getByRole('button', { name: 'Refund ₹570' }));
    expect(await screen.findByText('Refund #42 of ₹570 sent to Razorpay')).toBeTruthy();
    const calls = sent(server, 'POST', '/admin/orders/7/refunds');
    expect(calls.at(-1)!.body).toEqual({ kind: 'GOODWILL', reason: 'Lid was scratched', shippingAmount: 7000, codFeeAmount: 0, items: [{ orderItemId: 1, quantity: 1, amount: 50_000 }] });
    expect(new Set(calls.map((c) => c.headers['Idempotency-Key'])).size).toBe(1);
  });

  it('a server error on an item lands on that item’s field; COD not collected shows the reason; a closed gate is announced', async () => {
    const u = userEvent.setup();
    const { unmount } = setup('/orders/7', { 'POST /admin/orders/7/refunds': () => err(400, 'VALIDATION_ERROR', 'Request validation failed', [{ location: 'body', path: 'items.0.amount', message: 'At most ₹10,00,000' }]) });
    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Refund' }));
    await u.type(await dialog.findByLabelText('Amount: Epoxy Resin'), '100');
    await u.type(dialog.getByLabelText('Reason (kept on the refund)'), 'Price drop');
    await u.click(dialog.getByRole('button', { name: 'Refund ₹100' }));
    await waitFor(() => expectFieldError('Amount: Epoxy Resin', 'At most ₹10,00,000', dialog));
    unmount();
    setup('/orders/7', { 'GET /admin/orders/7': () => [200, order({ paymentMethod: 'COD', paymentStatus: 'COD_COLLECTED' })], 'GET /admin/orders/7/refundable': () => [200, refundable({ method: null, blockedReason: 'The cash hasn’t been collected yet, so there is nothing to refund.', payment: { ...refundable().payment!, reconciliationRequired: true } })] });
    await u.click(await screen.findByRole('button', { name: 'Refund' }));
    expect(await screen.findByText('The cash hasn’t been collected yet, so there is nothing to refund.')).toBeTruthy();
  });
});

describe('an order’s refunds and the queue', () => {
  it('retry a failed refund; record a COD transfer (reference required on its field); cancel an unpaid COD refund', async () => {
    const u = userEvent.setup();
    const manual = refund({ id: 43, method: 'MANUAL_BANK', status: 'REQUESTED', failureReason: null, attempts: [], actions: ['manual-processed', 'cancel'] });
    let rows = [refund(), manual];
    const { server } = setup('/orders/7', {
      'GET /admin/refunds': () => page(rows),
      'POST /admin/refunds/41/retry': () => { rows = [refund({ status: 'REQUESTED', failureReason: null, actions: [] }), manual]; return [202, rows[0]]; },
      'POST /admin/refunds/43/manual-processed': (c) => { rows = [rows[0]!, { ...manual, status: 'PROCESSED', manualReference: (c.body as { manualReference: string }).manualReference, actions: [] }]; return [200, rows[1]]; },
      'POST /admin/refunds/43/cancel': () => err(409, 'REFUND_NOT_CANCELLABLE', 'Only a bank-transfer (COD) refund that has not been paid can be cancelled.'),
    });
    const box = within(await screen.findByRole('region', { name: 'Refunds' }));
    expect(box.getByText('The refund amount provided is greater than amount captured')).toBeTruthy();
    await u.click(box.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Refund #41 sent again')).toBeTruthy();
    await waitFor(() => expect(box.queryByRole('button', { name: 'Retry' })).toBeNull());
    await u.click(box.getByRole('button', { name: 'Cancel refund #43' }));
    expect(await screen.findByText('Only a bank-transfer (COD) refund that has not been paid can be cancelled.')).toBeTruthy();
    await u.click(box.getByRole('button', { name: 'Record transfer' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Record the transfer for refund #43' }));
    await u.click(dialog.getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expectFieldError('Bank / UPI reference', 'Enter the bank or UPI reference', dialog));
    await u.type(dialog.getByLabelText('Bank / UPI reference'), 'UPI 4512');
    await u.click(dialog.getByRole('button', { name: 'Mark paid' }));
    expect(await screen.findByText('Refund #43 marked paid')).toBeTruthy();
    expect(sent(server, 'POST', '/admin/refunds/43/manual-processed')[0]!.body).toEqual({ manualReference: 'UPI 4512' });
    expect(await box.findByText('Reference UPI 4512')).toBeTruthy();
  });

  it('the queue: status filter sent to the server; attempts with receipt and HTTP status; links to the order', async () => {
    const u = userEvent.setup();
    const { server } = setup('/returns?view=refunds', { 'GET /admin/refunds': () => page([refund(), refund({ id: 44, status: 'UNKNOWN', failureReason: null, attempts: [{ no: 1, key: 'k', receipt: 'AQR_44_A1', status: 'UNKNOWN', lastHttpStatus: 504, sendCount: 2 }], actions: [] })]) });
    const table = within(await screen.findByRole('table', { name: 'Refunds' }));
    expect((await table.findAllByRole('link', { name: 'AQ10234' }))[0]!.getAttribute('href')).toBe('/orders/7');
    expect(table.getByText(/AQR_44_A1/).parentElement!.textContent).toBe('AQR_44_A1 · unknown · HTTP 504 · sent 2×');
    expect(table.getByText(/Checked again every 5 minutes/)).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Status'), 'FAILED');
    await waitFor(() => expect(sent(server, 'GET', '/admin/refunds').at(-1)!.query.get('status')).toBe('FAILED'));
  });
});
