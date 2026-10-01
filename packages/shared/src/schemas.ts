import { z } from 'zod';

// Strict schemas: unknown keys are rejected (architecture.md §5.9).
export const healthResponse = z.strictObject({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker']),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponse>;
