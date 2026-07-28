import { z } from 'zod';

/**
 * Folds an instance's actual value set into a tool input schema.
 *
 * The result is deliberately `enum | string`, not a bare enum. In JSON Schema
 * that becomes an `anyOf`, so a model reading the schema sees the concrete
 * values and picks from them, while a value that appeared in Zammad after the
 * client cached the tool list is still accepted rather than rejected by
 * client-side validation. Name-to-ID resolution in `LookupService` remains the
 * authority and returns a message listing the valid options when a value really
 * is wrong.
 */

/** A single reference: one of the known values, any other name, or a numeric ID. */
function reference(values: readonly string[]) {
  const id = z.number().int().positive();
  if (values.length === 0) return z.union([z.string().min(1), id]);
  return z.union([z.enum(values as [string, ...string[]]), z.string().min(1), id]);
}

/**
 * A reference field accepting one value or a list — the shape used by every
 * `state` / `priority` / `group` filter.
 */
export function referenceField(values: readonly string[], description: string) {
  const single = reference(values);
  return z
    .union([single, z.array(single).min(1)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .describe(describeWith(description, values));
}

/** A single-valued reference, for write tools where only one value makes sense. */
export function singleReferenceField(values: readonly string[], description: string) {
  if (values.length === 0) return z.string().optional().describe(description);
  return z
    .union([z.enum(values as [string, ...string[]]), z.string().min(1)])
    .optional()
    .describe(describeWith(description, values));
}

/**
 * The enum already carries the values machine-readably; repeating them in prose
 * would double the tokens in every tool listing. Only say where they came from.
 */
function describeWith(description: string, values: readonly string[]): string {
  if (values.length === 0) return description;
  return `${description} Values are read live from this Zammad instance; other names and numeric IDs are also accepted.`;
}
