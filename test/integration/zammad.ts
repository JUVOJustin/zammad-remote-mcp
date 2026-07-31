/**
 * Connection to the throwaway Zammad from `docker-compose.yml`.
 *
 * The integration tests skip themselves when nothing answers, so a normal
 * `npm test` on a machine without Docker stays green instead of failing on an
 * environment problem.
 */

export const BASE_URL =
  process.env.ZAMMAD_TEST_URL ?? `http://127.0.0.1:${process.env.ZAMMAD_TEST_PORT ?? 8085}`;
export const ADMIN_LOGIN = 'admin@example.test';
export const ADMIN_PASSWORD = 'IntegrationT3st!';

const authorization = `Basic ${Buffer.from(`${ADMIN_LOGIN}:${ADMIN_PASSWORD}`).toString('base64')}`;

export async function isReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/users/me`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; asUser?: string } = {},
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: authorization,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.asUser ? { 'X-On-Behalf-Of': init.asUser } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const AGENT_EMAIL = 'mira@example.test';
export const CUSTOMER_EMAIL = 'customer@example.test';

export interface SeededAgent {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
}

/**
 * The agent seed.rb created for the tests to mention.
 *
 * Looked up rather than created here: group access has to be granted through
 * `group_ids_access_map`, which the REST API does not expose, and without it a
 * mention lands on someone who cannot open the ticket.
 */
export async function seededAgent(): Promise<SeededAgent> {
  const found = await api<SeededAgent[]>(
    `/api/v1/users/search?query=${encodeURIComponent(AGENT_EMAIL)}&limit=1`,
  );
  const agent = found?.[0];
  if (!agent?.id) {
    throw new Error(`${AGENT_EMAIL} is missing — run test/integration/up.sh to seed it.`);
  }
  return agent;
}

export async function createTicket(title: string): Promise<{ id: number; number: string }> {
  return api('/api/v1/tickets', {
    method: 'POST',
    body: {
      title,
      group: 'Users',
      customer: CUSTOMER_EMAIL,
      article: { subject: title, body: 'Opened by the integration suite.', type: 'note', internal: false },
    },
  });
}

export interface Mention {
  user_id: number;
  mentionable_id: number;
  mentionable_type: string;
}

/** What Zammad recorded as mentions for a ticket — the thing the anchor is supposed to cause. */
export async function mentionsFor(ticketId: number): Promise<Mention[]> {
  const result = await api<{ mentions?: Mention[] }>(
    `/api/v1/mentions?mentionable_type=Ticket&mentionable_id=${ticketId}`,
  );
  return result?.mentions ?? [];
}

/**
 * Waits for Zammad to record a mention.
 *
 * `Mention` rows are written by a model callback, not inside the article
 * request, so reading straight after the write is a race — one that only shows
 * up when the suites run in parallel and the instance is busy. Polling removes
 * the flake without weakening the assertion: the mention still has to appear.
 */
export async function waitForMention(ticketId: number, userId: number, attempts = 20): Promise<Mention[]> {
  let mentions: Mention[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    mentions = await mentionsFor(ticketId);
    if (mentions.some((mention) => mention.user_id === userId)) return mentions;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return mentions;
}

export interface OnlineNotification {
  user_id: number;
  /** The id of the object it is about — the ticket, for a mention. */
  o_id: number;
  /** Zammad sends `object_lookup_id`, not a readable object name. */
  object_lookup_id: number;
  seen: boolean;
}

/**
 * Notifications belonging to `email`.
 *
 * The endpoint always answers for whoever is authenticated, so asking as the
 * admin would report the admin's notifications and quietly never show the
 * mentioned user's — hence X-On-Behalf-Of.
 */
export async function notificationsFor(email: string): Promise<OnlineNotification[]> {
  const result = await api<OnlineNotification[]>('/api/v1/online_notifications', { asUser: email });
  return Array.isArray(result) ? result : [];
}

/**
 * Waits until a fulltext search can see the seeded tickets.
 *
 * Returns immediately on this stack, which searches the database. It exists for
 * the moment Elasticsearch is added back: indexing is asynchronous there, and
 * an assertion made straight after seeding would fail on timing rather than on
 * behaviour — the most misleading kind of red.
 */
export async function waitForIndex(marker: string, expected: number, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const hits = await api<{ id: number }[]>(
        `/api/v1/tickets/search?query=${encodeURIComponent(marker)}&limit=100`,
      );
      const count = Array.isArray(hits) ? hits.length : 0;
      if (count >= expected) return;
    } catch {
      // The index may not exist yet on a fresh instance.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Elasticsearch never indexed ${expected} tickets matching "${marker}"`);
}
