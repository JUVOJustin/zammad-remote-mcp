/**
 * The release automation writes the version into `package.json` and nowhere
 * else, so that is where it is read from. The package imports its own manifest
 * by name — a relative path would leave `src` for the compiler and point
 * somewhere else once published — and the manifest is an exported path, so the
 * same import resolves from this checkout, from `node_modules` and in the Worker
 * bundle.
 */
import manifest from 'zammad-remote-mcp/package.json' with { type: 'json' };

export const SERVER_VERSION: string = manifest.version;
