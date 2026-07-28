#!/usr/bin/env bash
# Stops the test Zammad and removes its volumes.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down -v --remove-orphans
