/**
 * Composition helpers for Elasticsearch `query_string` syntax.
 *
 * Zammad hands the `query` parameter to Elasticsearch as a `query_string` with
 * `default_operator: AND`, `analyze_wildcard: true` and `time_zone` set from the
 * instance default (see `SearchIndexBackend.search_by_index`). It also appends a
 * `*` to "simple" queries — queries containing no Lucene syntax — so a bare word
 * behaves as a prefix search.
 */

/** Characters Lucene treats as syntax and that must be escaped inside a term. */
const RESERVED = /[+\-=&|><!(){}[\]^"~*?:\\/]/g;

/** Escape a value so Elasticsearch treats it as literal text. */
export function escapeTerm(value: string): string {
  return value.replace(RESERVED, (char) => `\\${char}`);
}

/**
 * Render a value for use on the right-hand side of `field:value`.
 * Anything with whitespace or reserved characters is quoted as a phrase, which
 * is both safer and closer to what a human means by `group:"1st Level"`.
 */
export function renderValue(value: string | number, options: { allowWildcards?: boolean } = {}): string {
  if (typeof value === 'number') return String(value);

  const trimmed = value.trim();
  if (trimmed === '') return '""';

  // An explicit wildcard is a deliberate act by the caller — keep it unquoted so
  // Elasticsearch still expands it, escaping everything else.
  if (options.allowWildcards && /[*?]/.test(trimmed)) {
    return trimmed.replace(/[+\-=&|><!(){}[\]^"~:\\/]/g, (char) => `\\${char}`);
  }

  if (/[\s"]/.test(trimmed) || RESERVED.test(trimmed)) {
    RESERVED.lastIndex = 0;
    return `"${trimmed.replace(/(["\\])/g, '\\$1')}"`;
  }
  RESERVED.lastIndex = 0;
  return trimmed;
}

export function fieldClause(
  field: string,
  value: string | number,
  options: { allowWildcards?: boolean } = {},
): string {
  return `${field}:${renderValue(value, options)}`;
}

/** `field:(a OR b OR c)` — a single clause matching any of the values. */
export function anyOf(
  field: string,
  values: readonly (string | number)[],
  options: { allowWildcards?: boolean } = {},
): string | undefined {
  const rendered = values.map((v) => renderValue(v, options)).filter(Boolean);
  if (rendered.length === 0) return undefined;
  if (rendered.length === 1) return `${field}:${rendered[0]}`;
  return `${field}:(${rendered.join(' OR ')})`;
}

/** `field:(a AND b AND c)` — every value must be present (multi-valued fields). */
export function allOf(
  field: string,
  values: readonly (string | number)[],
  options: { allowWildcards?: boolean } = {},
): string | undefined {
  const rendered = values.map((v) => renderValue(v, options)).filter(Boolean);
  if (rendered.length === 0) return undefined;
  if (rendered.length === 1) return `${field}:${rendered[0]}`;
  return `${field}:(${rendered.join(' AND ')})`;
}

/**
 * `field:[from TO to]`. Bounds may be ISO-8601 timestamps or Elasticsearch date
 * math (`now-7d`); `*` stands for an open end.
 */
export function range(
  field: string,
  from: string | number | undefined,
  to: string | number | undefined,
  options: { excludeLower?: boolean; excludeUpper?: boolean } = {},
): string | undefined {
  if (from === undefined && to === undefined) return undefined;
  const open = options.excludeLower ? '{' : '[';
  const close = options.excludeUpper ? '}' : ']';
  return `${field}:${open}${from ?? '*'} TO ${to ?? '*'}${close}`;
}

export function exists(field: string): string {
  return `_exists_:${field}`;
}

/** Combine clauses with a boolean operator, parenthesising as needed. */
export function combine(operator: 'AND' | 'OR', clauses: Array<string | undefined>): string | undefined {
  const parts = clauses.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts.map(group).join(` ${operator} `);
}

export function negate(clause: string | undefined): string | undefined {
  if (!clause) return undefined;
  return `NOT ${group(clause)}`;
}

/** Wrap in parentheses unless the clause is already a single atomic term. */
export function group(clause: string): string {
  const trimmed = clause.trim();
  if (isAtomic(trimmed)) return trimmed;
  return `(${trimmed})`;
}

function isAtomic(clause: string): boolean {
  if (/^\(.*\)$/.test(clause) && balanced(clause.slice(1, -1))) return true;
  // No top-level boolean operator and no spaces outside a quoted phrase.
  return !/\s(AND|OR|NOT)\s/.test(clause) && !/^NOT\s/.test(clause);
}

function balanced(clause: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < clause.length; i++) {
    const char = clause[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && !quoted;
}

/**
 * Free text typed by a human. Zammad only auto-appends `*` when the whole query
 * is "simple"; once we add field clauses that no longer holds, so the prefix
 * wildcard is applied here to keep bare-word searches behaving the same.
 */
export function freeText(text: string, options: { prefixWildcard?: boolean } = {}): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Anything that already looks like Lucene syntax is passed through untouched
  // so callers can hand-write advanced queries.
  if (/[:()"~^*?]|\s(AND|OR|NOT|TO)\s/.test(trimmed)) return trimmed;

  const words = trimmed.split(/\s+/).map(escapeTerm);
  if (!options.prefixWildcard) return words.join(' AND ');
  return words.map((word) => `${word}*`).join(' AND ');
}
