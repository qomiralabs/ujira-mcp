#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Qomira Labs
#
# Lints the up section of every migration with squawk, so a change that would
# block a live table (an index built without CONCURRENTLY, a constraint that
# scans while it holds a lock, a statement with no lock timeout) fails CI
# before it reaches a deploy.
#
# - Only the up section is linted: it is what a deploy runs. The down section
#   runs only on a rollback by hand. Every other line is blanked rather than
#   cut, so squawk's line numbers are the file's own.
# - A transactional file is linted as running inside a transaction, which is
#   how the runner runs it. A `-- no-transaction` file is linted as it runs,
#   outside one, without the two timeout rules: it holds one statement, so it
#   cannot set a timeout before that statement.
# - Findings in files from before this lint are accepted in
#   scripts/migration-lint-baseline.txt, by file and rule. An entry that no
#   longer matches a finding fails, so the list only shrinks, and so does an
#   entry for a file after LAST_BASELINED. A new migration fixes its finding,
#   or accepts it with `-- squawk-ignore <rule>` on the line before the
#   statement and a comment that says why.
#
# Usage: scripts/lint-migrations.sh [migration file...]
#   With no file, every file in db/migrations.
#   SQUAWK names the squawk binary, `squawk` on PATH by default.
#   MIGRATION_LINT_BASELINE names another baseline, for the self test.
# Exit codes: 0 clean, 1 a finding or a bad baseline, 2 a missing tool or file.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
squawk=${SQUAWK:-squawk}
baseline=${MIGRATION_LINT_BASELINE:-$here/scripts/migration-lint-baseline.txt}
config=$here/.squawk.toml
LAST_BASELINED=1800000000025
TIMEOUT_RULES=require-lock-timeout,require-statement-timeout

say() { echo "lint-migrations: $*" >&2; }

command -v "$squawk" >/dev/null 2>&1 || {
  say "squawk was not found; install it or set SQUAWK"
  exit 2
}
[ -f "$baseline" ] || {
  say "no baseline at $baseline"
  exit 2
}

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=("$here"/db/migrations/*.sql)
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/tx" "$work/notx"
problems=0
declare -A linted=()

for file in "${files[@]}"; do
  [ -f "$file" ] || {
    say "no such file: $file"
    exit 2
  }
  name=$(basename "$file")
  [ -z "${linted[$name]:-}" ] || {
    say "two files named $name"
    exit 2
  }
  linted[$name]=1
  if ! grep -qxF -- '-- Up Migration' "$file" || ! grep -qxF -- '-- Down Migration' "$file"; then
    say "$name has no '-- Up Migration' and '-- Down Migration' lines"
    problems=$((problems + 1))
    continue
  fi
  kind=tx
  [ "$(sed -n '2{s/\r$//;p}' "$file")" != '-- no-transaction' ] || kind=notx
  awk '{ sub(/\r$/, "") }
       $0 == "-- Up Migration" { up = 1; print ""; next }
       $0 == "-- Down Migration" { up = 0 }
       { print (up ? $0 : "") }' "$file" >"$work/$kind/$name"
done

# Runs squawk on one folder and appends its findings. squawk exits 1 when it
# finds something, so its exit code alone cannot tell a finding from a crash:
# every line it prints must read as a finding, and a failing exit must come
# with at least one.
findings=$work/findings
: >"$findings"
lint() {
  local dir=$1 out code=0
  shift
  compgen -G "$dir/*.sql" >/dev/null || return 0
  out=$(cd "$dir" && "$squawk" --config "$config" --reporter gcc "$@" -- *.sql 2>&1) || code=$?
  [ -n "$out" ] || {
    [ "$code" = 0 ] && return 0
    say "squawk exited $code with no findings"
    exit 2
  }
  if grep -vqE '^[^:]+\.sql:[0-9]+:[0-9]+: (warning|error): [a-z0-9-]+ ' <<<"$out"; then
    say "squawk printed something that is not a finding:"
    echo "$out" >&2
    exit 2
  fi
  echo "$out" >>"$findings"
}
lint "$work/tx" --assume-in-transaction
lint "$work/notx" --no-assume-in-transaction --exclude "$TIMEOUT_RULES"

# The accepted findings, as "<file> <rule>", comments and blank lines left out.
declare -A accepted=() matched=()
while read -r entry_file entry_rule rest; do
  case "$entry_file" in '' | \#*) continue ;; esac
  if [ -z "$entry_rule" ] || [ -n "$rest" ]; then
    say "baseline: '$entry_file $entry_rule $rest' is not '<file> <rule>'"
    problems=$((problems + 1))
    continue
  fi
  number=${entry_file%%_*}
  if ! [[ $number =~ ^[0-9]+$ ]] || [ "$number" -gt "$LAST_BASELINED" ]; then
    say "baseline: $entry_file is after $LAST_BASELINED; accept a finding in the file instead"
    problems=$((problems + 1))
    continue
  fi
  accepted["$entry_file $entry_rule"]=1
done <"$baseline"

# squawk counts lines and columns from 0; they are printed from 1, as an
# editor counts them.
finding_line='^([^:]+):([0-9]+):([0-9]+): (warning|error): ([a-z0-9-]+) (.*)$'
total=0
while IFS= read -r finding; do
  [ -n "$finding" ] || continue
  [[ $finding =~ $finding_line ]] || {
    say "cannot read the finding: $finding"
    exit 2
  }
  total=$((total + 1))
  file=${BASH_REMATCH[1]}
  rule=${BASH_REMATCH[5]}
  if [ -n "${accepted["$file $rule"]:-}" ]; then
    matched["$file $rule"]=1
  else
    echo "$file:$((BASH_REMATCH[2] + 1)):$((BASH_REMATCH[3] + 1)): ${BASH_REMATCH[4]}: $rule ${BASH_REMATCH[6]}" >&2
    problems=$((problems + 1))
  fi
done <"$findings"

for key in "${!accepted[@]}"; do
  [ -n "${linted[${key%% *}]:-}" ] || continue
  [ -n "${matched[$key]:-}" ] || {
    say "baseline: '$key' matches no finding any more; take it out"
    problems=$((problems + 1))
  }
done

if [ "$problems" -gt 0 ]; then
  say "$problems problem(s) in ${#linted[@]} migration(s)"
  exit 1
fi
echo "lint-migrations: ${#linted[@]} migration(s) clean, $total finding(s) all in the baseline"
