#!/usr/bin/env bash
#
# Boots the throwaway Zammad for the integration suite and seeds an admin.
#
# Setup is done by seed.rb rather than AUTOWIZARD_JSON: the entrypoint writes the
# autowizard payload inside the init container, whose tmp/ is shared with nothing,
# so the rails server never sees it and the instance sits in the setup wizard
# while the logs claim the payload was saved. See seed.rb.
#
# Re-running is safe. Pass KEEP_DATA=1 to reuse the existing database instead of
# starting from an empty one.

set -euo pipefail

cd "$(dirname "$0")"

PORT="${ZAMMAD_TEST_PORT:-8085}"
BASE="http://127.0.0.1:${PORT}"
LOGIN="admin@example.test"
PASSWORD='IntegrationT3st!'

export ZAMMAD_TEST_PORT="$PORT"

if [ "${KEEP_DATA:-0}" != "1" ]; then
  echo "Removing previous volumes..."
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
fi

echo "Starting Zammad on ${BASE} ..."
docker compose up -d --wait 2>&1 | tail -3

# The first boot migrates and seeds the database, which takes minutes.
echo -n "Waiting for the rails server"
for _ in $(seq 1 120); do
  if curl -sf -m 5 "${BASE}/api/v1/getting_started" >/dev/null 2>&1; then
    echo
    break
  fi
  echo -n "."
  sleep 5
done

echo "Seeding the admin..."
docker compose exec -T zammad-railsserver bundle exec rails r - < seed.rb

echo -n "Verifying the API"
for _ in $(seq 1 30); do
  if curl -sf -m 5 -u "${LOGIN}:${PASSWORD}" "${BASE}/api/v1/users/me" >/dev/null 2>&1; then
    echo
    echo "Ready — ${BASE}  ${LOGIN} / ${PASSWORD}"
    exit 0
  fi
  echo -n "."
  sleep 3
done

echo
echo "The API never accepted ${LOGIN}. Recent output:" >&2
docker compose logs --tail 30 zammad-railsserver >&2
exit 1
