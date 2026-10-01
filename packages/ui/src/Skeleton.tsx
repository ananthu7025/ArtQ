/** Loading placeholder. Hidden from assistive tech; pair it with a live "Loading…" status in the container. */
export function Skeleton({ width = '100%', height = 16, radius = 6 }: { width?: number | string; height?: number | string; radius?: number }) {
  return <span aria-hidden="true" data-skeleton="" style={{ display: 'block', width, height, borderRadius: radius, background: 'var(--surface-100)' }} />;
}
