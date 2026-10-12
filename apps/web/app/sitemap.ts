// /sitemap.xml (task 6.4): rebuilt at most once an hour from the API (lib/sitemap.ts).
import type { MetadataRoute } from 'next';
import { buildSitemap } from '../lib/sitemap';

export const revalidate = 3600;
export default function sitemap(): Promise<MetadataRoute.Sitemap> { return buildSitemap(); }
