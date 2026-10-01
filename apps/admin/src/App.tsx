import { formatINR } from '@artq/shared';
import { Button } from '@artq/ui';

// Phase 0 placeholder: proves Vite + shared packages + tokens. The admin shell is task 2.1.
export function App() {
  return (
    <main style={{ fontFamily: 'var(--font-body)', padding: 32, background: 'var(--surface-50)', minHeight: '100vh' }}>
      <h1 style={{ color: 'var(--ink-900)' }}>ArtQ Admin</h1>
      <p>Shared package check: {formatINR(1310000)}</p>
      <Button variant="secondary">Products</Button>
    </main>
  );
}
