// Customer order view helpers (task 5.7): the one status label a customer sees (product.md §8.5), and the access bodies.
import { describe, expect, it } from 'vitest';
import { customerDisplayStatus, orderAccessRequestBody, orderAccessVerifyBody, trackQuery } from './customer-order-schemas.js';

const o = (status: string, paymentStatus = 'PAID', fulfilmentStatus = 'UNFULFILLED', returnStatus = 'NONE') => ({ status, paymentStatus, fulfilmentStatus, returnStatus });

describe('customerDisplayStatus', () => {
  it.each([
    [o('PENDING_PAYMENT', 'UNPAID'), 'Awaiting payment'], [o('PENDING_PAYMENT', 'PROCESSING'), 'Payment processing'], [o('EXPIRED', 'UNPAID'), 'Payment not completed'],
    [o('PLACED'), 'Order placed'], [o('CONFIRMED'), 'Confirmed'], [o('CONFIRMED', 'PAID', 'PACKED'), 'Packed'], [o('CONFIRMED', 'PAID', 'SHIPPED'), 'Shipped'],
    [o('CONFIRMED', 'COD_PENDING', 'OUT_FOR_DELIVERY'), 'Out for delivery'], [o('CONFIRMED', 'COD_COLLECTED', 'DELIVERED'), 'Delivered'],
    [o('CONFIRMED', 'PAID', 'DELIVERED', 'OPEN'), 'Return in progress'], [o('CONFIRMED', 'PARTIALLY_REFUNDED', 'DELIVERED', 'CLOSED'), 'Partially refunded'],
    [o('CANCELLED', 'REFUNDED'), 'Refunded'], [o('CANCELLED', 'PAID'), 'Cancelled'], [o('CANCELLED', 'NOT_COLLECTED', 'RTO_RECEIVED'), 'Cancelled'],
  ])('%j → %s', (input, label) => { expect(customerDisplayStatus(input)).toBe(label); });
});

describe('order access bodies', () => {
  it('email and code use the shared rules; unknown keys refused; tracking tokens are URL-safe and 20–100 long', () => {
    expect(orderAccessRequestBody.parse({ email: '  Hema@Example.com ' }).email).toBe('Hema@Example.com');
    expect(orderAccessRequestBody.safeParse({ email: 'x' }).success).toBe(false);
    expect(orderAccessVerifyBody.safeParse({ email: 'a@b.in', code: '123456' }).success).toBe(true);
    expect(orderAccessVerifyBody.safeParse({ email: 'a@b.in', code: '12345' }).success).toBe(false);
    expect(orderAccessVerifyBody.safeParse({ email: 'a@b.in', code: '123456', extra: 1 }).success).toBe(false);
    expect(trackQuery.safeParse({ token: 'a'.repeat(20) }).success).toBe(true);
    expect(trackQuery.safeParse({ token: 'a'.repeat(19) }).success).toBe(false);
    expect(trackQuery.safeParse({ token: 'a'.repeat(100) }).success).toBe(true);
    expect(trackQuery.safeParse({ token: 'a'.repeat(101) }).success).toBe(false);
    expect(trackQuery.safeParse({ token: `${'a'.repeat(20)}.x` }).success).toBe(false);
  });
});
