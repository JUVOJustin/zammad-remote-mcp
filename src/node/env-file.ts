import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Loads a `.env` file into `process.env` before configuration is validated.
 *
 * Uses Node's built-in `process.loadEnvFile` (v20.12+) rather than a dependency.
 * Variables already present in the real environment win over the file, which is
 * what lets a one-off `ZAMMAD_URL=… npm start` override a committed default and
 * keeps container/systemd environments authoritative in production.
 */

export type EnvFileResult =
  | { status: 'loaded'; path: string }
  | { status: 'absent'; path: string }
  | { status: 'unsupported'; path: string }
  | { status: 'failed'; path: string; error: string };

/**
 * @param explicitPath value of `ENV_FILE`, if the operator set one. When given,
 *   a missing file is reported as `failed` rather than quietly skipped — asking
 *   for a specific file and not getting it should not pass silently.
 */
export function loadEnvFile(explicitPath?: string, cwd: string = process.cwd()): EnvFileResult {
  const requested = explicitPath?.trim();
  const target = requested
    ? isAbsolute(requested)
      ? requested
      : resolve(cwd, requested)
    : resolve(cwd, '.env');

  if (!existsSync(target)) {
    return requested
      ? { status: 'failed', path: target, error: 'file does not exist' }
      : { status: 'absent', path: target };
  }

  if (typeof process.loadEnvFile !== 'function') {
    return { status: 'unsupported', path: target };
  }

  try {
    process.loadEnvFile(target);
    return { status: 'loaded', path: target };
  } catch (error) {
    return {
      status: 'failed',
      path: target,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
