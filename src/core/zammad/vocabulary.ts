import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import type { LookupService } from './lookup.js';

/**
 * The closed value sets of a particular Zammad instance — its states,
 * priorities, groups and macros — read once per request (served from the lookup
 * cache in practice) and folded into the tool input schemas as enums.
 *
 * This replaces four discovery tools. Instead of the model calling
 * `zammad_list_ticket_states` to learn that "pending close" exists and only then
 * searching, the value is in the schema it is already looking at. Fewer round
 * trips, and far fewer searches built on a guessed state name.
 *
 * Three properties keep that from becoming a liability:
 *
 *  - **Never fatal.** Every fetch is individually tolerated. A 403 (agent tokens
 *    cannot read admin endpoints), a timeout or an outage yields an empty
 *    vocabulary and the schemas fall back to plain strings — `tools/list` keeps
 *    working, which matters because it is how a client discovers anything at all.
 *  - **Bounded.** Above `SCHEMA_ENUM_MAX_VALUES` entries the enum is dropped
 *    rather than pasting hundreds of group names into every tool listing.
 *  - **Advisory.** The enum is unioned with a free string, so a value created in
 *    Zammad after a client cached the schema is still accepted. Resolution stays
 *    server-side in `LookupService`, which is the real authority.
 */

export interface Vocabulary {
  states: string[];
  priorities: string[];
  groups: string[];
  macros: Array<{ id: number; name: string }>;
  /** What could not be read, for the log and for tool descriptions. */
  unavailable: string[];
}

export const EMPTY_VOCABULARY: Vocabulary = {
  states: [],
  priorities: [],
  groups: [],
  macros: [],
  unavailable: [],
};

interface MacroRecord {
  id: number;
  name: string;
  active?: boolean;
}

export async function loadVocabulary(
  lookup: LookupService,
  config: Config,
  logger: Logger,
): Promise<Vocabulary> {
  if (!config.DYNAMIC_TOOL_SCHEMAS) return EMPTY_VOCABULARY;

  const unavailable: string[] = [];

  /** Resolve to `[]` on any failure — discovery must never depend on Zammad being healthy. */
  const tolerate = async <T>(label: string, load: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await load();
    } catch (error) {
      unavailable.push(label);
      logger.debug('vocabulary source unavailable', {
        source: label,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const [states, priorities, groups, macros] = await Promise.all([
    tolerate('ticket_states', () => lookup.states()),
    tolerate('ticket_priorities', () => lookup.priorities()),
    tolerate('groups', () => lookup.groups()),
    tolerate('macros', () => lookup.macros()),
  ]);

  const cap = config.SCHEMA_ENUM_MAX_VALUES;

  return {
    states: names(states, cap),
    priorities: names(priorities, cap),
    groups: names(groups, cap),
    macros: (macros as MacroRecord[])
      .filter((macro) => macro.active !== false)
      .slice(0, cap)
      .map((macro) => ({ id: macro.id, name: macro.name })),
    unavailable,
  };
}

/**
 * Active records only — an inactive state is still a valid filter value in
 * principle, but offering it as a suggestion mostly produces empty results.
 * Over the cap the list is dropped entirely: a truncated enum is worse than
 * none, because it looks authoritative while silently omitting valid values.
 */
function names(records: Array<{ name: string; active?: boolean }>, cap: number): string[] {
  const active = records.filter((record) => record.active !== false).map((record) => record.name);
  const unique = [...new Set(active)].filter(Boolean);
  return unique.length > cap ? [] : unique;
}
