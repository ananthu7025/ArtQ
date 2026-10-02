// Product description rich text, sanitised server-side (architecture.md §9: `sanitize-html` allowlist). The editor
// produces a small subset of HTML; anything else (scripts, styles, event handlers, images, iframes) is removed.
import sanitizeHtml from 'sanitize-html';

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false,
  // b/i from pasted content become their semantic equivalents; external links never get access to window.opener.
  transformTags: {
    b: 'strong', i: 'em', h1: 'h3', h2: 'h3',
    // A link without a safe address becomes plain text (span is not allowed, so only its words remain).
    a: (_tag, attribs) => (SAFE_HREF.test(attribs.href ?? '')
      ? { tagName: 'a', attribs: { href: attribs.href!, target: '_blank', rel: 'noopener noreferrer nofollow' } }
      : { tagName: 'span', attribs: {} }),
  },
};

/**
 * Clean HTML for storage, or null when nothing readable remains (so `<p></p>` cannot satisfy the "description" check
 * of the publication gate).
 */
export function sanitizeDescription(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  const clean = sanitizeHtml(html, OPTIONS).trim();
  const text = sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;|\s/g, '');
  return text === '' ? null : clean;
}
