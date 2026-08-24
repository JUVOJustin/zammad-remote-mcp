import type { Config } from '../config.js';
import type { CacheStore } from '../util/cache.js';
import { createMemoryCacheStore, JsonCache } from '../util/cache.js';
import { ToolInputError } from '../util/errors.js';
import type { ZammadClient } from './client.js';

/**
 * Resolves human-friendly search inputs ("open", "1st Level", "jane@acme.com")
 * into the numeric IDs that Zammad selectors filter on. Filtering by ID is both
 * exact and backend-independent — `ticket.state_id` behaves identically on the
 * SQL and Elasticsearch paths, whereas name-based joins do not.
 *
 * The cache is a pure latency optimisation: it is per-process, per-credential
 * and TTL-bounded, and every entry can be rebuilt from Zammad at any time. No
 * request depends on a cache populated by an earlier request, so the server
 * stays horizontally scalable and effectively stateless.
 */

/**
 * The cache backend. Defaults to an in-process store; a host can install a
 * shared one — the Cloudflare package installs Workers KV, because each isolate
 * would otherwise start cold and re-read the same lists.
 */
let store: CacheStore = createMemoryCacheStore();

export function setLookupCacheStore(next: CacheStore): void {
  store = next;
}

/** Exposed for tests and for the `zammad_refresh_metadata_cache` tool. */
export function clearLookupCache(): Promise<void> {
  return store.clear();
}

export interface TicketState {
  id: number;
  name: string;
  active: boolean;
  state_type_id: number;
  state_type?: string;
  ignore_escalation?: boolean;
}

export interface TicketPriority {
  id: number;
  name: string;
  active: boolean;
}

export interface Group {
  id: number;
  name: string;
  active: boolean;
  /** Present on Zammad instances that use nested groups. */
  name_last?: string;
  /** The signature the agent UI appends for this group; null when unset. */
  signature_id?: number | null;
}

export interface Signature {
  id: number;
  name: string;
  /** HTML, with `#{…}` placeholders left unrendered. */
  body: string;
  active: boolean;
}

/** A user a `@@mention` may name: an agent, with the name to print for them. */
export interface MentionableUser {
  id: number;
  name: string;
}

/** One search hit, with the two identities a token may name them by. */
export interface MentionCandidate extends MentionableUser {
  email?: string;
  login?: string;
}

/** What a mention anchor shows — the full name, falling back to what identifies them. */
function displayName(user: ZammadUser, fallback: string): string {
  const full = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return full || user.email || user.login || fallback;
}

export interface ZammadUser {
  id: number;
  login?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  organization_id?: number | null;
  active?: boolean;
}

export interface Macro {
  id: number;
  name: string;
  active?: boolean;
  note?: string;
}

export interface Organization {
  id: number;
  name: string;
  active?: boolean;
  domain?: string;
}

/** What `signshow` is kept for — see `LookupService.session`. */
interface SessionProjection {
  config: Record<string, string | number | boolean>;
  signatures: Record<string, Signature>;
}

/**
 * Zammad ships six state types; `pending reminder` and `pending action` are the
 * two pending flavours. Used to expand `state_type: ['open']` into concrete IDs.
 */
export const STATE_TYPES = [
  'new',
  'open',
  'pending reminder',
  'pending action',
  'closed',
  'merged',
  'removed',
] as const;
export type StateType = (typeof STATE_TYPES)[number];

export class LookupService {
  constructor(
    private readonly client: ZammadClient,
    private readonly config: Config,
  ) {}

  private get cache(): JsonCache {
    return new JsonCache(store, this.config.METADATA_CACHE_TTL_SECONDS);
  }

  private key(name: string): string {
    return `${this.client.baseUrl}|${this.client.fingerprint}|${name}`;
  }

  states(): Promise<TicketState[]> {
    return this.cache.read(this.key('ticket_states'), () =>
      // `expand=true` swaps `state_type_id` for the readable `state_type` name.
      this.client.get<TicketState[]>('/api/v1/ticket_states', { expand: true, per_page: 200 }),
    );
  }

  priorities(): Promise<TicketPriority[]> {
    return this.cache.read(this.key('ticket_priorities'), () =>
      this.client.get<TicketPriority[]>('/api/v1/ticket_priorities', { per_page: 200 }),
    );
  }

  groups(): Promise<Group[]> {
    return this.cache.read(this.key('groups'), () =>
      this.client.get<Group[]>('/api/v1/groups', { per_page: 500 }),
    );
  }

  /**
   * Every tag on the instance, by name.
   *
   * `/api/v1/tag_list` is the admin CRUD endpoint and 403s for an agent token.
   * `tag_search` is the one agents may call, and it matches everything when no
   * term narrows it — but it caps at ten unless a limit is given, which is a
   * silent truncation the caller cannot see. Verified against 7.1.1: 10 of 32
   * without a limit, all 32 with. The limit is asked for one above the schema
   * cap so the vocabulary can tell "this many" from "more than the cap".
   *
   * No `term` is sent at all. An empty string would be equivalent to Zammad,
   * but `ZammadClient` drops empty query values, so passing one would have
   * described a request this never makes.
   */
  tags(limit: number): Promise<string[]> {
    return this.cache.read(this.key(`tag_list:${limit}`), async () => {
      const rows = await this.client.get<Array<{ value?: string }>>('/api/v1/tag_search', { limit });
      return Array.isArray(rows) ? rows.map((row) => row.value).filter((v): v is string => !!v) : [];
    });
  }

  macros(): Promise<Macro[]> {
    return this.cache.read(this.key('macros'), () =>
      this.client.get<Macro[]>('/api/v1/macros', { per_page: 200 }),
    );
  }

  /** Macro by name (case-insensitive) or numeric ID. */
  async resolveMacro(value: string | number): Promise<number> {
    const macros = await this.macros();
    return resolveByName(
      value,
      macros,
      'macro',
      (macro) => macro.name,
      (macro) => macro.id,
    );
  }

  me(): Promise<ZammadUser> {
    return this.cache.read(this.key('me'), () => this.client.get<ZammadUser>('/api/v1/users/me'));
  }

  /**
   * The signatures this credential can see.
   *
   * `/api/v1/signatures` is readable by agents on a stock Zammad, but the
   * permission is configurable, so a 403 falls back to the copy the agent UI
   * itself uses — `signshow` hands the session its `Signature` assets whatever
   * the REST endpoint allows.
   */
  signatures(): Promise<Signature[]> {
    return this.cache.read(this.key('signatures'), async () => {
      try {
        return await this.client.get<Signature[]>('/api/v1/signatures', { per_page: 200 });
      } catch {
        return Object.values((await this.session()).signatures);
      }
    });
  }

  /**
   * Zammad's frontend settings — `fqdn`, `product_name` and the rest of what
   * `#{config.…}` in a signature can address. There is no REST endpoint for
   * these that a non-admin may read; `signshow` is where the UI gets them.
   */
  async frontendConfig(): Promise<Record<string, string | number | boolean>> {
    return (await this.session()).config;
  }

  /**
   * `/api/v1/signshow` — Zammad's `sessions#show`, the payload the agent UI
   * boots from. The response is ~130 KB of models and collections, so only the
   * two parts anything here needs are cached: the scalar settings and the
   * signature assets.
   */
  private session(): Promise<SessionProjection> {
    return this.cache.read(this.key('signshow'), async () => {
      const response = await this.client.get<{
        config?: Record<string, unknown>;
        assets?: { Signature?: Record<string, Signature> };
      }>('/api/v1/signshow');

      const config: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(response?.config ?? {})) {
        // Settings are also objects and arrays; a placeholder can only print a scalar.
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean') {
          config[name] = value as string | number | boolean;
        }
      }

      return { config, signatures: response?.assets?.Signature ?? {} };
    });
  }

  // ------------------------------------------------------------- resolution

  /**
   * Accepts an ID, an exact name or a case-insensitive name and returns the ID.
   * Throws a descriptive error listing the valid options — that message goes
   * straight back to the model, which can then retry with a correct value.
   */
  async resolveStates(values: readonly (string | number)[]): Promise<number[]> {
    const states = await this.states();
    return values.map((value) =>
      resolveByName(
        value,
        states,
        'ticket state',
        (s) => s.name,
        (s) => s.id,
      ),
    );
  }

  async resolveStateTypes(types: readonly StateType[]): Promise<number[]> {
    const states = await this.states();
    const wanted = new Set(types.map((t) => t.toLowerCase()));
    const matches = states.filter((s) => s.state_type && wanted.has(s.state_type.toLowerCase()));

    if (matches.length === 0) {
      const available = [...new Set(states.map((s) => s.state_type).filter(Boolean))].sort();
      throw new ToolInputError(
        `No ticket states found for state_type ${JSON.stringify(types)}. ` +
          `This Zammad instance exposes: ${available.join(', ') || '(state types unavailable — use `state` with explicit names)'}.`,
      );
    }
    return matches.map((s) => s.id);
  }

  async resolvePriorities(values: readonly (string | number)[]): Promise<number[]> {
    const priorities = await this.priorities();
    return values.map((value) =>
      resolveByName(
        value,
        priorities,
        'ticket priority',
        (p) => p.name,
        (p) => p.id,
      ),
    );
  }

  async resolveGroups(values: readonly (string | number)[]): Promise<number[]> {
    const groups = await this.groups();
    return values.map((value) =>
      resolveByName(
        value,
        groups,
        'group',
        (g) => g.name,
        (g) => g.id,
      ),
    );
  }

  /**
   * Users are unbounded, so they are resolved through Zammad's own user search
   * rather than a cached list. An exact login/email match always wins over a
   * fuzzy hit so that `jane@acme.com` never silently matches `jane2@acme.com`.
   */
  async resolveUsers(values: readonly (string | number)[]): Promise<number[]> {
    const ids: number[] = [];
    for (const value of values) {
      if (typeof value === 'number') {
        ids.push(value);
        continue;
      }
      const numeric = Number(value);
      if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === value.trim()) {
        ids.push(numeric);
        continue;
      }
      // `me` is the authenticated user, as it already is in the search filters
      // (`owner: ["me"]`). Claimed here rather than looked up: a login spelled
      // exactly `me` would otherwise mean two things depending on the tool, and
      // the token is worth more than that login is likely.
      if (value.trim().toLowerCase() === 'me') {
        ids.push((await this.me()).id);
        continue;
      }
      ids.push(await this.resolveOneUser(value));
    }
    return ids;
  }

  /**
   * The agents a `@@token` could be naming — candidates, not an answer.
   *
   * Mirrors `App.Mention.searchUser` (mention.coffee), which is what the agent
   * UI's `@@` picker offers: `/api/v1/users/search` narrowed to the roles that
   * carry `ticket.agent` and to the users with `read` access to the ticket's
   * group. Both filters are honoured by `User.search` on the database and the
   * Elasticsearch path alike (`app/models/user/search.rb`); `permissions` is
   * turned into those role ids by `search_params_pre`, so the roles do not have
   * to be fetched and matched here.
   *
   * Narrowing is not a nicety. `Validations::MentionValidator` refuses a mention
   * of anyone without `agent_read_access?` to the ticket, and both writing
   * endpoints set `check_mentions_raises_error = true`
   * (`creates_ticket_articles.rb`), so mentioning a customer does not quietly do
   * nothing — it fails the article with a 422 and nothing is written at all.
   *
   * What comes back is still only what the search matched, and the search
   * matches prefixes: "Jan" returns Janine, "me" returns Melanie. Deciding which
   * of these the author actually named is `mentions.ts`, which is the only place
   * that can see what they wrote.
   */
  async mentionableAgents(term: string, groupId?: number): Promise<MentionCandidate[]> {
    const key = this.key(`mention:${groupId ?? 'any'}:${term.toLowerCase()}`);
    return this.cache.read(key, async () => {
      const users = await this.client.get<ZammadUser[]>('/api/v1/users/search', {
        query: term,
        permissions: 'ticket.agent',
        // Rails reads `group_ids[7]=read` as `{group_ids: {"7" => "read"}}`,
        // which is the shape `User.search` expects.
        ...(groupId === undefined ? {} : { [`group_ids[${groupId}]`]: 'read' }),
        limit: 25,
      });

      return (
        (Array.isArray(users) ? users : [])
          // Zammad's search does not exclude deactivated accounts — it sorts by
          // `active` rather than filtering on it. The group filter would have
          // dropped them (`User.group_access` is `where(active: true)` on both its
          // direct and its role half), but it is not always there to do it: a bulk
          // update spans many groups and passes none. A colleague who has left
          // cannot be mentioned — `agent_read_access?` is false for anyone
          // inactive — so offering them can only produce a 422 or a confusing
          // candidate in an ambiguity error.
          .filter((user) => user.active !== false)
          .map((user) => ({
            id: user.id,
            name: displayName(user, String(user.id)),
            email: user.email,
            login: user.login,
          }))
      );
    });
  }

  /**
   * The agent a numeric id names, or `undefined` if that id is not one.
   *
   * An id is an identity, so it needs no name to match — but it does need the
   * same test of who may be mentioned. Rather than guess at permissions from the
   * user record, the id is turned into the address it belongs to and put through
   * `mentionableAgents`, so an id belonging to a customer, or to an agent
   * without access to the group, is refused exactly like the name of one.
   */
  async mentionableAgentById(id: number, groupId?: number): Promise<MentionCandidate | undefined> {
    const user = await this.client.get<ZammadUser>(`/api/v1/users/${id}`).catch(() => undefined);
    const identifier = user?.email || user?.login;
    if (!identifier) return undefined;
    return (await this.mentionableAgents(identifier, groupId)).find((agent) => agent.id === id);
  }

  private async resolveOneUser(term: string): Promise<number> {
    const key = this.key(`user:${term.toLowerCase()}`);
    return this.cache.read(key, async () => {
      const users = await this.client.get<ZammadUser[]>('/api/v1/users/search', {
        query: term,
        limit: 25,
      });
      if (!Array.isArray(users) || users.length === 0) {
        throw new ToolInputError(
          `No Zammad user matches "${term}". Use a login, email address or numeric user ID, ` +
            'or call `zammad_search_users` first to find the right account.',
        );
      }

      const needle = term.trim().toLowerCase();
      const exact = users.find((u) => u.email?.toLowerCase() === needle || u.login?.toLowerCase() === needle);
      if (exact) return exact.id;

      if (users.length > 1) {
        const candidates = users
          .slice(0, 10)
          .map(
            (u) =>
              `${u.id}: ${[u.firstname, u.lastname].filter(Boolean).join(' ')} <${u.email ?? u.login ?? '?'}>`,
          )
          .join('; ');
        throw new ToolInputError(
          `"${term}" matches ${users.length} Zammad users; pass an exact email, login or ID. Candidates — ${candidates}`,
        );
      }
      return users[0]!.id;
    });
  }

  async resolveOrganizations(values: readonly (string | number)[]): Promise<number[]> {
    const ids: number[] = [];
    for (const value of values) {
      if (typeof value === 'number') {
        ids.push(value);
        continue;
      }
      const numeric = Number(value);
      if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === value.trim()) {
        ids.push(numeric);
        continue;
      }
      ids.push(await this.resolveOneOrganization(value));
    }
    return ids;
  }

  private async resolveOneOrganization(term: string): Promise<number> {
    return this.cache.read(this.key(`org:${term.toLowerCase()}`), async () => {
      const orgs = await this.client.get<Organization[]>('/api/v1/organizations/search', {
        query: term,
        limit: 25,
      });
      if (!Array.isArray(orgs) || orgs.length === 0) {
        throw new ToolInputError(
          `No Zammad organization matches "${term}". Use the exact name or a numeric organization ID.`,
        );
      }
      const needle = term.trim().toLowerCase();
      const exact = orgs.find((o) => o.name?.toLowerCase() === needle);
      if (exact) return exact.id;
      if (orgs.length > 1) {
        const candidates = orgs
          .slice(0, 10)
          .map((o) => `${o.id}: ${o.name}`)
          .join('; ');
        throw new ToolInputError(
          `"${term}" matches ${orgs.length} organizations; pass an exact name or ID. Candidates — ${candidates}`,
        );
      }
      return orgs[0]!.id;
    });
  }
}

function resolveByName<T>(
  value: string | number,
  items: readonly T[],
  label: string,
  nameOf: (item: T) => string,
  idOf: (item: T) => number,
): number {
  if (typeof value === 'number') return value;

  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === trimmed) return numeric;

  const needle = trimmed.toLowerCase();
  const match =
    items.find((item) => nameOf(item) === trimmed) ??
    items.find((item) => nameOf(item).toLowerCase() === needle) ??
    // Nested groups are addressed as `Parent::Child`; allow the leaf name too.
    items.find((item) => nameOf(item).toLowerCase().split('::').pop() === needle);

  if (!match) {
    const available = items.map(nameOf).sort().join(', ');
    throw new ToolInputError(
      `Unknown ${label} "${value}". Available: ${available || '(none returned by Zammad)'}.`,
    );
  }
  return idOf(match);
}
