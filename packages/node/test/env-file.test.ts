import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadEnvFile } from '../src/env-file.js';

let dir: string;
const touched: string[] = [];

/** Set a variable and remember it, so the real environment is left as found. */
function setEnv(key: string, value: string) {
  touched.push(key);
  process.env[key] = value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zammad-mcp-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of touched.splice(0)) delete process.env[key];
  for (const key of ['ZMCP_T_A', 'ZMCP_T_B', 'ZMCP_T_QUOTED']) delete process.env[key];
});

describe('loadEnvFile', () => {
  it('loads a .env from the working directory', () => {
    writeFileSync(join(dir, '.env'), 'ZMCP_T_A=from_file\n');

    const result = loadEnvFile(undefined, dir);
    assert.equal(result.status, 'loaded');
    assert.equal(process.env.ZMCP_T_A, 'from_file');
  });

  it('lets the real environment win over the file', () => {
    // This is what makes `ZAMMAD_URL=… npm start` able to override a committed
    // default, and keeps container environments authoritative.
    setEnv('ZMCP_T_B', 'from_shell');
    writeFileSync(join(dir, '.env'), 'ZMCP_T_B=from_file\n');

    loadEnvFile(undefined, dir);
    assert.equal(process.env.ZMCP_T_B, 'from_shell');
  });

  it('strips surrounding quotes, as in ZAMMAD_URL="https://…"', () => {
    writeFileSync(join(dir, '.env'), 'ZMCP_T_QUOTED="https://support.example.com"\n');

    loadEnvFile(undefined, dir);
    assert.equal(process.env.ZMCP_T_QUOTED, 'https://support.example.com');
  });

  it('is a no-op when no .env exists', () => {
    const result = loadEnvFile(undefined, dir);
    assert.equal(result.status, 'absent');
    assert.match(result.path, /\.env$/);
  });

  it('honours an explicit ENV_FILE path', () => {
    writeFileSync(join(dir, 'staging.env'), 'ZMCP_T_A=from_named_file\n');

    const result = loadEnvFile('staging.env', dir);
    assert.equal(result.status, 'loaded');
    assert.equal(process.env.ZMCP_T_A, 'from_named_file');
  });

  it('reports a missing ENV_FILE instead of skipping it silently', () => {
    const result = loadEnvFile('nope.env', dir);
    assert.equal(result.status, 'failed');
  });
});
