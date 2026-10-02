// Product description sanitising (architecture.md §9): the allowlist, and "empty" HTML counted as no description.
import { describe, expect, it } from 'vitest';
import { sanitizeDescription } from '../src/catalog/rich-text.js';

describe('sanitizeDescription', () => {
  it('keeps the editor subset', () => {
    const html = '<h3>Use</h3><p><strong>Mix</strong> 2:1 by <em>volume</em>.</p><ul><li>Stir 3 min</li></ul><ol><li>Pour</li></ol><blockquote>Tip</blockquote>';
    expect(sanitizeDescription(html)).toBe(html);
  });

  it.each([
    ['scripts', '<p>Hi</p><script>alert(1)</script>', '<p>Hi</p>'],
    ['event handlers', '<p onclick="steal()">Hi</p>', '<p>Hi</p>'],
    ['inline styles and classes', '<p style="color:red" class="x">Hi</p>', '<p>Hi</p>'],
    ['images and iframes', '<p>Hi<img src="x" onerror="y"><iframe src="https://evil"></iframe></p>', '<p>Hi</p>'],
    ['javascript: links (the link is dropped, its text kept)', '<p><a href="javascript:alert(1)">click</a></p>', '<p>click</p>'],
    ['b / i / h1 from pasted content', '<h1>T</h1><p><b>B</b><i>I</i></p>', '<h3>T</h3><p><strong>B</strong><em>I</em></p>'],
  ])('removes %s', (_l, input, out) => {
    expect(sanitizeDescription(input)).toBe(out);
  });

  it('links open safely in a new tab', () => {
    expect(sanitizeDescription('<p><a href="https://artq.in/guide" target="_self" rel="opener">Guide</a></p>'))
      .toBe('<p><a href="https://artq.in/guide" target="_blank" rel="noopener noreferrer nofollow">Guide</a></p>');
  });

  it.each([[null], [undefined], [''], ['<p></p>'], ['<p> &nbsp; </p><br>'], ['<script>x</script>']])('%j has no readable text → null', (input) => {
    expect(sanitizeDescription(input as string | null | undefined)).toBeNull();
  });
});
