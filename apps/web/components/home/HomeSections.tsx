// Home sections in the order the API returns (the HOME_SECTIONS setting, empty ones left out).
import type { HomeSectionKey, HomeView } from '@artq/shared';
import type { ReactNode } from 'react';
import { Hero } from './Hero';
import { Reels } from './Reels';
import { InstagramBand, ProductRow, Techniques, TypeTiles } from './Sections';
import { Testimonials } from './Testimonials';

export function HomeSections({ home }: { home: HomeView }) {
  const render: Record<HomeSectionKey, () => ReactNode> = {
    hero: () => <Hero slides={home.hero.slides} intervalMs={home.hero.intervalMs} />,
    types: () => <TypeTiles types={home.types} />,
    'new-arrivals': () => <ProductRow id="new-arrivals-heading" title="New Arrivals" subtitle="Explore our newly launched products" cards={home.newArrivals} viewAll="/new-arrivals" />,
    reels: () => <Reels reels={home.reels} />,
    trending: () => <ProductRow id="trending-heading" title="Trending now" cards={home.trending} viewAll="/trending" />,
    techniques: () => <Techniques techniques={home.techniques} />,
    testimonials: () => <Testimonials items={home.testimonials} />,
    instagram: () => (home.instagram.handle && home.instagram.url ? <InstagramBand handle={home.instagram.handle} url={home.instagram.url} /> : null),
  };
  // The page always has its h1: in the hero, or (when the hero is switched off) a visually hidden one.
  return (
    <>
      {!home.sections.includes('hero') && <h1 className="sr-only">ArtQ: wood moulds &amp; resins</h1>}
      {home.sections.map((k) => <div key={k} data-section={k}>{render[k]()}</div>)}
    </>
  );
}
