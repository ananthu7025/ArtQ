// The checkout form (task 4.6). Its values follow the page (a saved address or a new one, a GST toggle); they are turned
// into the POST /checkout/initiate body and checked with the shared checkoutInitiateBody, unchanged (validation rule),
// so every message and limit is the server's and error paths match the server's (`shippingAddress.pincode`, …).
import { checkoutInitiateBody, type CheckoutPaymentMethod } from '@artq/shared';
import { z } from 'zod';

type AddressValues = { fullName: string; phone: string; line1: string; line2: string; landmark: string; city: string; stateId: number | undefined; pincode: string };
export type CheckoutValues = {
  contact: { email: string; phone: string; sendSetPasswordLink: boolean };
  /** A saved address id, or 'new'. */
  addressChoice: string;
  shippingAddress: AddressValues & { label: 'HOME' | 'WORK' | 'OTHER'; save: boolean };
  billingSameAsShipping: boolean;
  billingAddress: AddressValues;
  gstOn: boolean;
  gstin: string;
  businessName: string;
  paymentMethod: CheckoutPaymentMethod;
  customerNote: string;
  acceptTerms: boolean;
};

const emptyAddress = (): AddressValues => ({ fullName: '', phone: '', line1: '', line2: '', landmark: '', city: '', stateId: undefined, pincode: '' });
export function emptyCheckout(o: { email?: string; phone?: string; name?: string; addressChoice?: string } = {}): CheckoutValues {
  return {
    contact: { email: o.email ?? '', phone: o.phone ?? '', sendSetPasswordLink: false },
    addressChoice: o.addressChoice ?? 'new',
    shippingAddress: { ...emptyAddress(), fullName: o.name ?? '', phone: o.phone ?? '', label: 'HOME', save: true },
    billingSameAsShipping: true,
    billingAddress: emptyAddress(),
    gstOn: false, gstin: '', businessName: '',
    paymentMethod: 'RAZORPAY', customerNote: '', acceptTerms: false,
  };
}

const address = ({ stateId, ...a }: AddressValues) => ({ ...a, ...(stateId === undefined ? {} : { stateId }) });

export function toInitiateBody(v: CheckoutValues, expectedTotal: number, signedIn: boolean): unknown {
  const isNew = v.addressChoice === 'new';
  return {
    contact: { email: v.contact.email, phone: v.contact.phone, sendSetPasswordLink: !signedIn && v.contact.sendSetPasswordLink },
    shippingAddressId: isNew ? null : Number(v.addressChoice),
    shippingAddress: isNew ? { ...address(v.shippingAddress), label: v.shippingAddress.label, save: signedIn && v.shippingAddress.save } : null,
    billingSameAsShipping: v.billingSameAsShipping,
    billingAddress: v.billingSameAsShipping ? null : address(v.billingAddress),
    gstin: v.gstOn && v.gstin.trim() ? v.gstin : null,
    businessName: v.gstOn ? v.businessName : null,
    paymentMethod: v.paymentMethod,
    customerNote: v.customerNote,
    expectedTotal,
    acceptTerms: v.acceptTerms === true ? true : v.acceptTerms,
  };
}

/** The form schema: the shared body rules on the converted values. `getTotal` is the total of the latest quote. */
export function checkoutForm(getTotal: () => number, signedIn: boolean) {
  return z.custom<CheckoutValues>().transform((v, ctx) => {
    const r = checkoutInitiateBody.safeParse(toInitiateBody(v, getTotal(), signedIn));
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: i.path as (string | number)[], message: i.message });
      return z.NEVER;
    }
    return r.data;
  });
}

/** Fields a server VALIDATION_ERROR can name (for applyServerErrors). */
const ADDRESS_FIELDS = ['fullName', 'phone', 'line1', 'line2', 'landmark', 'city', 'stateId', 'pincode'] as const;
export const CHECKOUT_FIELDS = [
  'contact.email', 'contact.phone', ...ADDRESS_FIELDS.map((f) => `shippingAddress.${f}` as const), 'shippingAddress',
  ...ADDRESS_FIELDS.map((f) => `billingAddress.${f}` as const), 'billingAddress', 'gstin', 'businessName', 'paymentMethod', 'customerNote', 'acceptTerms',
] as const;
