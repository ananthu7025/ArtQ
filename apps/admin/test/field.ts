// Validation rule (CLAUDE.md): an invalid field is marked aria-invalid (red border via styles.css) and its message is the
// element directly under it, linked with aria-describedby.
import { screen } from '@testing-library/react';
import { expect } from 'vitest';

export function expectFieldError(label: string, message: string, root: { getByLabelText: typeof screen.getByLabelText } = screen) {
  const field = root.getByLabelText(label);
  expect(field.getAttribute('aria-invalid'), `${label} is marked invalid`).toBe('true');
  const ids = (field.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  const texts = ids.map((id) => document.getElementById(id)?.textContent);
  expect(texts, `${label} describes its error`).toContain(message);
  const errorEl = document.getElementById(`${field.id}-error`)!;
  expect(errorEl.className).toContain('text-danger-700');
  // directly under the field: the message follows the input in the same field wrapper
  expect(field.parentElement!.contains(errorEl)).toBe(true);
  expect(field.compareDocumentPosition(errorEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

export function expectFieldValid(label: string, root: { getByLabelText: typeof screen.getByLabelText } = screen) {
  expect(root.getByLabelText(label).getAttribute('aria-invalid')).toBeNull();
}
