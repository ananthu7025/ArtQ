// Client-only additions to shared request schemas (validation rule: a form may only add fields, never change a rule).
import { z } from 'zod';

/**
 * The shared schema, unchanged, plus a client-only `repeat` field that must equal `field`. The shared schema sees the
 * body without `repeat` (shared bodies are strict), and both kinds of error are reported together.
 */
export function withRepeat<S extends z.ZodType<object, object>>(schema: S, field: string, message = 'The passwords do not match') {
  return z.looseObject({ repeat: z.string() }).transform((value, ctx) => {
    const { repeat, ...body } = value as Record<string, unknown> & { repeat: string };
    const parsed = schema.safeParse(body);
    if (!parsed.success) for (const i of parsed.error.issues) ctx.addIssue({ code: 'custom', path: i.path, message: i.message });
    if (body[field] !== repeat) ctx.addIssue({ code: 'custom', path: ['repeat'], message });
    return parsed.success && body[field] === repeat ? { ...(parsed.data as z.output<S>), repeat } : z.NEVER;
  }) as unknown as z.ZodType<z.output<S> & { repeat: string }, z.input<S> & { repeat: string }>;
}
