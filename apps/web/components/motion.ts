'use client';
// "Keep it still": reduced motion or the browser's data saver. Read through useSyncExternalStore so the server render
// (and the first client render) assume still, and the page follows the setting if it changes.
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';
type Conn = { saveData?: boolean; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
const conn = () => (navigator as Navigator & { connection?: Conn }).connection;

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener?.('change', onChange);
  conn()?.addEventListener?.('change', onChange);
  return () => { mq.removeEventListener?.('change', onChange); conn()?.removeEventListener?.('change', onChange); };
}

/** True when moving or auto-playing content should stay still: reduced motion, or save-data (only the latter for `dataOnly`). */
export function useStill(dataOnly = false): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(conn()?.saveData) || (!dataOnly && window.matchMedia(QUERY).matches), () => true);
}
