import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Badge, Button, IconButton, Input, Price, SectionTitle, Skeleton } from '../src/index.js';

afterEach(cleanup);

async function expectNoAxeViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } }); // contrast is covered by contrast.test.ts
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe('Button', () => {
  it('calls onClick and defaults to type="button"', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Add to cart</Button>);
    const b = screen.getByRole('button', { name: 'Add to cart' });
    expect(b.getAttribute('type')).toBe('button');
    await userEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('disabled: stays focusable, is announced, swallows clicks', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Pay</Button>);
    const b = screen.getByRole('button', { name: 'Pay' });
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.hasAttribute('disabled')).toBe(false);
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it('loading: aria-busy, status text, swallows clicks (no double submit)', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Place order</Button>);
    const b = screen.getByRole('button');
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    await userEvent.click(b); await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it('can be submit when asked', () => {
    render(<form><Button type="submit">Save</Button></form>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });
});

describe('IconButton', () => {
  it('exposes its label as the accessible name and hides the icon', () => {
    render(<IconButton label="Open cart" icon={<svg />} />);
    const b = screen.getByRole('button', { name: 'Open cart' });
    expect(b.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
  it('refuses an empty label', () => {
    expect(() => render(<IconButton label="  " icon={<svg />} />)).toThrow(/non-empty label/);
  });
});

describe('Input', () => {
  it('is reachable by its label', () => {
    render(<Input label="Pincode" name="pincode" />);
    expect(screen.getByLabelText('Pincode').getAttribute('name')).toBe('pincode');
  });
  it('error: aria-invalid, alert, linked by aria-describedby together with the hint', () => {
    render(<Input label="Pincode" error="Enter a 6-digit pincode" hint="We deliver across India" />);
    const input = screen.getByLabelText('Pincode');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = input.getAttribute('aria-describedby')!.split(' ');
    expect(ids).toHaveLength(2);
    expect(screen.getByRole('alert').id).toBe(ids[0]);
    expect(document.getElementById(ids[1]!)!.textContent).toBe('We deliver across India');
  });
  it('without error: not invalid, no alert, no describedby', () => {
    render(<Input label="Name" />);
    const input = screen.getByLabelText('Name');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('generates unique ids for multiple inputs', () => {
    render(<><Input label="A" /><Input label="B" /></>);
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id);
  });
});

describe('Price', () => {
  it('shows price, struck MRP and discount when MRP is higher', () => {
    const { container } = render(<Price price={9000} mrp={12000} />);
    expect(container.textContent).toContain('₹90');
    expect(container.querySelector('s')!.textContent).toBe('MRP ₹120');
    expect(container.textContent).toContain('25% OFF');
  });
  it('hides MRP and discount when MRP is missing, equal or lower', () => {
    for (const mrp of [null, 9000, 8000]) {
      const { container, unmount } = render(<Price price={9000} mrp={mrp} />);
      expect(container.querySelector('s')).toBeNull();
      expect(container.textContent).not.toContain('OFF');
      unmount();
    }
  });
  it('supports "From" for price ranges and paise formatting', () => {
    const { container } = render(<Price price={805050} from />);
    expect(container.textContent).toBe('From ₹8,050.50');
  });
  it('rejects non-integer or negative paise', () => {
    expect(() => render(<Price price={90.5} />)).toThrow(RangeError);
    expect(() => render(<Price price={-1} />)).toThrow(RangeError);
    expect(() => render(<Price price={100} mrp={1.5} />)).toThrow(RangeError);
  });
});

describe('SectionTitle, Badge, Skeleton', () => {
  it('renders the heading at the requested level with decorative lines hidden', () => {
    const { container } = render(<SectionTitle title="Product Category" eyebrow="Check out our range" subtitle="Explore" level={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Product Category' })).toBeTruthy();
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });
  it('badge conveys status as text', () => {
    render(<Badge tone="danger">Out of stock</Badge>);
    expect(screen.getByText('Out of stock')).toBeTruthy();
  });
  it('skeleton is hidden from assistive technology', () => {
    const { container } = render(<Skeleton height={20} />);
    expect(container.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('accessibility (axe-core)', () => {
  it('a composed form has no violations', async () => {
    const { container } = render(
      <main>
        <SectionTitle title="Checkout" />
        <Input label="Email" type="email" error="Enter a valid email" />
        <Input label="Pincode" hint="6 digits" />
        <Price price={49900} mrp={59900} />
        <Badge tone="new">New</Badge>
        <Button>Place order</Button>
        <Button loading>Saving</Button>
        <IconButton label="Close" icon={<svg />} />
        <Skeleton />
      </main>,
    );
    await expectNoAxeViolations(container);
  });
});
