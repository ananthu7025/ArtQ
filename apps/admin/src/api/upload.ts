// Image upload (architecture.md §9.1): presign → PUT straight to storage → complete. Returns the media id; the image is
// then processed in the background (UPLOADED → PROCESSING → READY / FAILED).
import type { AdminApi } from './client';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

/** A message when the file cannot be uploaded as an image, else null (the server checks again, by content). */
export function imageProblem(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name}: use a JPEG, PNG, WebP or AVIF image`;
  if (file.size > IMAGE_MAX_BYTES) return `${file.name}: images can be at most 15 MB`;
  return null;
}

export async function uploadImage(api: AdminApi, file: File): Promise<number> {
  const p = await api.request<{ media: { id: number }; upload: { url: string; headers: Record<string, string> } }>('POST', '/admin/media/presign', {
    body: { filename: file.name, contentType: file.type, size: file.size, purpose: 'product-image' },
  });
  // Content-Length is set by the browser itself (a forbidden header); the signature covers the same value.
  const put = await fetch(p.upload.url, { method: 'PUT', body: file, headers: { 'Content-Type': p.upload.headers['Content-Type'] ?? file.type } });
  if (!put.ok) throw new Error(`Upload of ${file.name} failed (${put.status})`);
  await api.request('POST', `/admin/media/${p.media.id}/complete`, { body: {} });
  return p.media.id;
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A catalogue workbook: presign (purpose catalog-import, private) → PUT → complete. Returns the media id. */
export async function uploadWorkbook(api: AdminApi, file: File): Promise<number> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error(`${file.name}: choose an Excel .xlsx file`);
  if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name}: workbooks can be at most 5 MB`);
  const p = await api.request<{ media: { id: number }; upload: { url: string; headers: Record<string, string> } }>('POST', '/admin/media/presign', {
    body: { filename: file.name, contentType: XLSX_TYPE, size: file.size, purpose: 'catalog-import' },
  });
  const put = await fetch(p.upload.url, { method: 'PUT', body: file, headers: { 'Content-Type': XLSX_TYPE } });
  if (!put.ok) throw new Error(`Upload of ${file.name} failed (${put.status})`);
  await api.request('POST', `/admin/media/${p.media.id}/complete`, { body: {} });
  return p.media.id;
}

/** Saves a Blob as a file in the browser. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
