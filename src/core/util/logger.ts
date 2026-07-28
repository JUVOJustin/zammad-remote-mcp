type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Where a rendered log line goes. Defaults to `console.error`, which reaches
 * stderr on Node and the log stream on edge runtimes — `process.stderr` exists
 * on neither reliably. stdout is deliberately left untouched so the same build
 * can be piped into a stdio MCP transport without corrupting frames.
 */
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  // biome-ignore lint/suspicious/noConsole: this is the log sink itself, the one place where console output is the intent
  console.error(line);
};

/** Structured line logger. */
export function createLogger(
  level: Level,
  bindings: Record<string, unknown> = {},
  sink: LogSink = defaultSink,
): Logger {
  const threshold = RANK[level];

  const emit = (lvl: Exclude<Level, 'silent'>, msg: string, meta?: unknown) => {
    if (RANK[lvl] < threshold) return;
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...bindings,
    };
    if (meta !== undefined) record.meta = redact(meta);
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}

const SECRET_KEY =
  /(authorization|token|secret|password|client_secret|code_verifier|refresh_token|access_token)/i;

/** Shallow-ish redaction so credentials never reach the log sink. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}
