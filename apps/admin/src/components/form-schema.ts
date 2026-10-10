// Forms whose inputs are text in the admin's units (rupees, grams, days) but whose rules live in a shared @artq/shared
// schema (CLAUDE.md "Validation rule"). The form checks only the text format; then the converted body is validated by
// the shared schema, unchanged, and its issues land on the fields with the same path (as the server's would).
import { z } from 'zod';

export const RUPEES = /^\d{1,7}(\.\d{1,2})?$/;
export const WHOLE = /^\d{1,7}$/;
export const RUPEES_MESSAGE = 'Use rupees with at most two decimals, e.g. 150 or 99.50';
export const WHOLE_MESSAGE = 'Use a whole number';
export const toPaise = (s: string) => Math.round(Number(s.trim()) * 100);
export const fromPaise = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2).replace(/\.00$/, ''));
/** '' → null, '12' → 12, otherwise NaN (the shared schema then reports it). */
export const optionalNumber = (s: string) => (s.trim() === '' ? null : Number(s.trim()));

export type FormatProblem = [path: (string | number)[], message: string];

export function convertedForm<V, S extends z.ZodType>(format: (v: V) => FormatProblem[], toBody: (v: V) => unknown, shared: S, mapPath: (path: (string | number)[]) => (string | number)[] = (p) => p) {
  return z.custom<V>().transform((v, ctx) => {
    const problems = format(v);
    for (const [path, message] of problems) ctx.addIssue({ code: 'custom', path, message });
    if (problems.length) return z.NEVER;
    const r = shared.safeParse(toBody(v));
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: mapPath(i.path as (string | number)[]), message: i.message });
      return z.NEVER;
    }
    return r.data as z.output<S>;
  });
}

/** Format checks for rupee inputs (empty allowed: the shared schema decides whether a value is required). */
export function rupeeProblems(entries: [path: (string | number)[], value: string][]): FormatProblem[] {
  return entries.filter(([, v]) => v.trim() !== '' && !RUPEES.test(v.trim())).map(([p]) => [p, RUPEES_MESSAGE]);
}
export function wholeProblems(entries: [path: (string | number)[], value: string][], message = WHOLE_MESSAGE): FormatProblem[] {
  return entries.filter(([, v]) => v.trim() !== '' && !WHOLE.test(v.trim())).map(([p]) => [p, message]);
}
