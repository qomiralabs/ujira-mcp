#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Qomira Labs
#
# Self test for lint-migrations.sh: squawk must reject the unsafe fixture, pass
# the safe forms of the same change, and the baseline must accept only what it
# names. Run with the same SQUAWK as the lint itself.
set -euo pipefail

scripts="$(cd "$(dirname "$0")" && pwd)"
lint="$scripts/lint-migrations.sh"
unsafe="$scripts/fixtures/migrations/1900000000000_blocking_index.sql"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
ok() {
  passed=$((passed + 1))
  echo "ok: $1"
}
bad() {
  failed=$((failed + 1))
  echo "FAILED: $1"
}

empty_baseline="$work/empty-baseline.txt"
echo '# nothing accepted' >"$empty_baseline"

# expect <name> <exit code> <pattern> <baseline> <file...>
expect() {
  local name=$1 code=$2 pattern=$3 base=$4 output rc=0
  shift 4
  output=$(MIGRATION_LINT_BASELINE="$base" "$lint" "$@" 2>&1) || rc=$?
  if [ "$rc" = "$code" ] && grep -qE -- "$pattern" <<<"$output"; then
    ok "$name"
  else
    bad "$name (exit $rc): $output"
  fi
}

# write <file name> <up section lines...>: a migration with that up section.
write() {
  local file="$work/$1"
  shift
  {
    echo '-- expand'
    [ "${NO_TRANSACTION:-}" = 1 ] && echo '-- no-transaction'
    echo '-- Up Migration'
    printf '%s\n' "$@"
    echo '-- Down Migration'
    echo 'select 1;'
  } >"$file"
  echo "$file"
}

expect 'the committed migrations pass with the committed baseline' 0 'migration\(s\) clean' \
  "$scripts/migration-lint-baseline.txt"

expect 'an index built without CONCURRENTLY fails' 1 \
  '1900000000000_blocking_index\.sql:15:[0-9]+: warning: require-concurrent-index-creation' \
  "$empty_baseline" "$unsafe"

concurrent=$(NO_TRANSACTION=1 write 1900000000001_concurrent.sql \
  'create index concurrently if not exists payouts_created_at on ujira.payouts (created_at);')
expect 'the same index built CONCURRENTLY, outside a transaction, passes' 0 '1 migration\(s\) clean' \
  "$empty_baseline" "$concurrent"

untimed=$(write 1900000000002_untimed.sql \
  'alter table ujira.payouts add column note text;')
expect 'a transactional change with no lock timeout fails' 1 'require-lock-timeout' \
  "$empty_baseline" "$untimed"

ignored=$(write 1900000000003_ignored.sql \
  "set local lock_timeout = '5s';" \
  "set local statement_timeout = '60s';" \
  '-- The table is created in the migration before and holds no rows yet.' \
  '-- squawk-ignore require-concurrent-index-creation' \
  'create index payouts_created_at on ujira.payouts (created_at);')
expect 'a finding accepted in the file passes' 0 '1 migration\(s\) clean' \
  "$empty_baseline" "$ignored"

downs=$(write 1900000000004_down_only.sql "set local lock_timeout = '5s';" \
  "set local statement_timeout = '60s';" 'create table ujira.notes (id bigint primary key);')
sed -i 's/^select 1;$/drop table ujira.payouts;/' "$downs"
expect 'the down section is not linted' 0 '1 migration\(s\) clean' "$empty_baseline" "$downs"

old="$work/1700000000000_blocking_index.sql"
cp "$unsafe" "$old"
printf '%s\n' '# accepted' '1700000000000_blocking_index.sql require-concurrent-index-creation' \
  >"$work/accepts-old.txt"
expect 'the baseline accepts a finding it names in an older file' 0 '1 finding\(s\) all in the baseline' \
  "$work/accepts-old.txt" "$old"

printf '%s\n' '1700000000000_blocking_index.sql require-concurrent-index-creation' \
  '1700000000000_blocking_index.sql ban-drop-column' >"$work/stale.txt"
expect 'a baseline entry that matches nothing fails' 1 "'1700000000000_blocking_index.sql ban-drop-column' matches no finding" \
  "$work/stale.txt" "$old"

printf '%s\n' '1900000000000_blocking_index.sql require-concurrent-index-creation' >"$work/too-new.txt"
expect 'the baseline cannot accept a finding in a new file' 1 'is after 1800000000025' \
  "$work/too-new.txt" "$unsafe"

printf 'not a migration\n' >"$work/1900000000005_no_markers.sql"
expect 'a file with no section markers fails' 1 'has no .-- Up Migration' \
  "$empty_baseline" "$work/1900000000005_no_markers.sql"

rc=0
output=$(SQUAWK="$work/no-such-squawk" MIGRATION_LINT_BASELINE="$empty_baseline" "$lint" "$unsafe" 2>&1) ||
  rc=$?
if [ "$rc" = 2 ] && grep -q 'squawk was not found' <<<"$output"; then
  ok 'a missing squawk is a tool error, not a pass'
else
  bad "a missing squawk is a tool error, not a pass (exit $rc): $output"
fi

echo "lint-migrations.test: $passed passed, $failed failed"
[ "$failed" = 0 ]
