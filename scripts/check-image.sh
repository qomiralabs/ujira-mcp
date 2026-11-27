#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Qomira Labs
#
# Runs a built image the way a host does and checks each role:
#
# - unset UJIRA_ROLES runs web and worker; /healthz answers through the
#   published port; SIGTERM stops the web role first, then the worker, and the
#   container exits 0 within 20 s;
# - UJIRA_ROLES=web answers /healthz and starts no worker;
# - UJIRA_ROLES=worker opens no port, needs none of the web settings, and
#   stops cleanly;
# - an unknown role exits 1 with a message that names it;
# - with no database configured the migration step is skipped;
# - with a Postgres (the one docker-compose.yml pins), two instances started
#   together run every migration in the image once, before their roles start,
#   and a migration that fails exits 1 before any role starts.
#
# The web role needs an agent key and a mandate address to start. This script
# makes a fresh unfunded key and a made up contract address inside the image,
# writes them to a private temporary file and never prints them.
#
# Usage: scripts/check-image.sh <image> [first host port, default 18080]
# Exit codes: 0 every check passed, 1 one failed.
set -euo pipefail

image=${1:?usage: scripts/check-image.sh <image> [first host port]}
here=$(cd "$(dirname "$0")/.." && pwd)
base_port=${2:-18080}
budget_seconds=20
run_id="ujira-check-$$"
work=$(mktemp -d)
containers=()

cleanup() {
  for name in "${containers[@]}"; do docker rm --force "$name" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "check-image: $*" >&2
  exit 1
}

# Prints the container's log once, for the step that failed.
show_logs() {
  echo "check-image: logs of $1" >&2
  docker logs "$1" >&2 2>&1 || true
}

# Polls a URL until it answers 200, for up to 60 seconds.
wait_healthy() {
  python3 - "$1" <<'PY'
import sys, time, urllib.request
url = sys.argv[1]
deadline = time.monotonic() + 60
while True:
    try:
        with urllib.request.urlopen(url, timeout=5) as res:
            if res.status == 200:
                sys.exit(0)
    except Exception:
        pass
    if time.monotonic() > deadline:
        sys.exit(1)
    time.sleep(1)
PY
}

# Waits up to 60 seconds for a line in the container's log.
wait_log() {
  local name=$1 line=$2
  for _ in $(seq 1 60); do
    if docker logs "$name" 2>&1 | grep -qF -- "$line"; then return 0; fi
    [ "$(docker inspect --format '{{.State.Running}}' "$name")" = "true" ] || break
    sleep 1
  done
  show_logs "$name"
  fail "$name never logged: $line"
}

# Sends SIGTERM through docker stop and checks the exit code and the time taken.
stop_within_budget() {
  local name=$1 started elapsed code
  started=$(date +%s)
  docker stop --time $((budget_seconds + 10)) "$name" >/dev/null
  elapsed=$(($(date +%s) - started))
  code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
  if [ "$code" != "0" ]; then
    show_logs "$name"
    fail "$name exited $code after SIGTERM, not 0"
  fi
  if [ "$elapsed" -ge "$budget_seconds" ]; then
    show_logs "$name"
    fail "$name took ${elapsed}s to stop, the budget is ${budget_seconds}s"
  fi
  echo "check-image: $name stopped with exit 0 in ${elapsed}s"
}

start() {
  local name=$1
  shift
  containers+=("$name")
  docker run --detach --name "$name" "$@" "$image" >/dev/null
}

env_file="$work/web.env"
(
  umask 077
  docker run --rm --entrypoint node "$image" --input-type=module -e "
    import { randomBytes } from 'node:crypto';
    import { Keypair, StrKey } from '@stellar/stellar-sdk';
    process.stdout.write('UJIRA_AGENT_SECRET=' + Keypair.random().secret() + '\n');
    process.stdout.write('UJIRA_MANDATE_ID=' + StrKey.encodeContract(randomBytes(32)) + '\n');
  " >"$env_file"
)
[ "$(grep -c '^UJIRA_' "$env_file")" = "2" ] || fail "could not make the throwaway keys"

# 1. An unknown role refuses to start and says why.
set +e
refused=$(docker run --rm -e UJIRA_ROLES=web,jobs "$image" 2>&1)
code=$?
set -e
[ "$code" = "1" ] || fail "an unknown role exited $code, not 1"
expected='ujira-server: UJIRA_ROLES must be web, worker or web,worker; "jobs" is not a role'
[ "$refused" = "$expected" ] || fail "an unknown role printed: $refused"
echo "check-image: an unknown role exits 1 with: $refused"

# 2. The default runs both roles, as the live service does.
both="$run_id-both"
start "$both" --env-file "$env_file" --publish "127.0.0.1:${base_port}:8080"
wait_log "$both" '"service":"ujira-server","event":"log","message":"running web,worker"'
docker logs "$both" 2>&1 |
  grep -qF '"service":"ujira-server","event":"log","message":"migrations skipped: UJIRA_DB_MIGRATOR_URL is not set"' ||
  {
    show_logs "$both"
    fail "with no database the migration step did not say it was skipped"
  }
echo "check-image: with no database the migration step is skipped"
wait_healthy "http://127.0.0.1:${base_port}/healthz" || {
  show_logs "$both"
  fail "/healthz did not answer 200 with both roles"
}
echo "check-image: /healthz answers 200 with both roles"
uid=$(docker exec "$both" sh -c 'cat /proc/1/status' | awk '/^Uid:/ { print $2 }')
[ "$uid" != "0" ] || fail "the server runs as root"
stop_within_budget "$both"
logs=$(docker logs "$both" 2>&1)
web_line=$(grep -n -F '"service":"ujira-server","event":"log","message":"web stopped"' <<<"$logs" | cut -d: -f1)
worker_line=$(grep -n -F '"service":"ujira-server","event":"log","message":"worker stopped"' <<<"$logs" | cut -d: -f1)
if [ -z "$web_line" ] || [ -z "$worker_line" ] || [ "$web_line" -ge "$worker_line" ]; then
  fail "the web role did not stop before the worker"
fi
echo "check-image: SIGTERM stopped web, then worker"

# 3. The web role alone.
web="$run_id-web"
start "$web" --env-file "$env_file" -e UJIRA_ROLES=web --publish "127.0.0.1:$((base_port + 1)):8080"
wait_log "$web" '"service":"ujira-server","event":"log","message":"running web"'
wait_healthy "http://127.0.0.1:$((base_port + 1))/healthz" || {
  show_logs "$web"
  fail "/healthz did not answer 200 with the web role"
}
if docker logs "$web" 2>&1 | grep -q 'ujira-worker'; then fail "the web role started a worker"; fi
stop_within_budget "$web"

# 4. The worker role alone: no settings for the web role, and no listener.
worker="$run_id-worker"
start "$worker" -e UJIRA_ROLES=worker
wait_log "$worker" '"service":"ujira-server","event":"log","message":"running worker"'
if docker exec "$worker" node -e "
  fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz')
    .then(() => process.exit(0), () => process.exit(1))
"; then
  fail "the worker role answers HTTP"
fi
echo "check-image: the worker role has no HTTP listener"
stop_within_budget "$worker"

# 5. Migrations before the roles start, against a real Postgres. The image's
# containers share its network, so the database is on their loopback address,
# the only place UJIRA_DB_TLS=off is accepted.
pg_image=$(awk '$1 == "image:" && $2 ~ /^postgres:/ { print $2; exit }' "$here/docker-compose.yml")
[ -n "$pg_image" ] || fail "no Postgres image in docker-compose.yml"
pg="$run_id-pg"
pg_password="check-$$-$RANDOM"
containers+=("$pg")
docker run --detach --name "$pg" -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=ujira \
  "$pg_image" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$pg" pg_isready --quiet --host 127.0.0.1 --username postgres && break
  sleep 1
done
docker exec "$pg" pg_isready --quiet --host 127.0.0.1 --username postgres || {
  show_logs "$pg"
  fail "Postgres did not become ready"
}
db_env=(--network "container:$pg" -e UJIRA_ROLES=worker -e UJIRA_DB_TLS=off
  -e "UJIRA_DB_MIGRATOR_URL=postgresql://postgres:${pg_password}@127.0.0.1:5432/ujira")
expected=$(find "$here/db/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
shipped=$(docker run --rm --entrypoint sh "$image" -c 'ls /app/db/migrations/*.sql | wc -l' | tr -d ' ')
[ "$shipped" = "$expected" ] || fail "the image ships $shipped migrations, the repository has $expected"
ledger() {
  docker exec "$pg" psql --username postgres --dbname ujira --no-psqlrc --tuples-only --no-align \
    --command 'select count(*), count(distinct name) from public.ujira_migrations'
}

first="$run_id-migrate-1"
second="$run_id-migrate-2"
start "$first" "${db_env[@]}"
start "$second" "${db_env[@]}"
wait_log "$first" '"service":"ujira-server","event":"log","message":"running worker"'
wait_log "$second" '"service":"ujira-server","event":"log","message":"running worker"'
[ "$(ledger)" = "$expected|$expected" ] || fail "the ledger holds $(ledger), not $expected once each"
applied=0
for name in "$first" "$second"; do
  logs=$(docker logs "$name" 2>&1)
  if grep -qF "\"message\":\"migrations applied ${expected}: " <<<"$logs"; then
    applied=$((applied + 1))
  elif ! grep -qF '"message":"migrations up to date, nothing to run"' <<<"$logs"; then
    show_logs "$name"
    fail "$name neither applied the migrations nor found them up to date"
  fi
  ran=$(grep -n -F '"message":"migrations ' <<<"$logs" | tail -1 | cut -d: -f1)
  running=$(grep -n -F '"message":"running worker"' <<<"$logs" | cut -d: -f1)
  [ "$ran" -lt "$running" ] || fail "$name started its role before its migrations finished"
  if grep -qF "$pg_password" <<<"$logs"; then fail "$name logged the database password"; fi
done
[ "$applied" = 1 ] || fail "$applied instances applied the migrations, not 1"
echo "check-image: two instances started together ran $expected migrations once, before their roles"
stop_within_budget "$first"
stop_within_budget "$second"

# A failed migration exits 1 before any role starts, and the ledger is as it was.
broken="$work/broken-migrations"
mkdir -p "$broken"
cp "$here"/db/migrations/*.sql "$broken/"
printf '%s\n' '-- expand' '-- Up Migration' 'select * from public.nowhere;' '-- Down Migration' \
  'select 1;' >"$broken/1999999999999_broken.sql"
chmod 0755 "$broken"
chmod 0644 "$broken"/*.sql
set +e
refused=$(docker run --rm "${db_env[@]}" -v "$broken:/app/db/migrations:ro" "$image" 2>&1)
code=$?
set -e
[ "$code" = "1" ] || fail "a failed migration exited $code, not 1: $refused"
grep -qE '^ujira-server: migrations failed: .*nowhere' <<<"$refused" ||
  fail "a failed migration printed: $refused"
if grep -qF '"message":"running' <<<"$refused"; then fail "a role started after a failed migration"; fi
if grep -qF "$pg_password" <<<"$refused"; then fail "a failed migration printed the database password"; fi
[ "$(ledger)" = "$expected|$expected" ] || fail "a failed migration changed the ledger: $(ledger)"
echo "check-image: a failed migration exits 1 before any role starts"

echo "check-image: every role check passed"
