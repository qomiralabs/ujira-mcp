# ujira-mcp
MCP server for UJIRA payouts, a thin adapter over the UJIRA API.

## Dashes

No file may contain an em dash or an en dash. `scripts/check-dashes.sh` searches the content git holds for every tracked file, prints each hit as `path:line:text` and exits 1 on any. Every file is read as text, so a NUL byte cannot make one look binary and skip the check; a file is skipped only when its extension is one of a short list of binary formats and its content starts with that format's signature. A dash in a path fails too, reported as the path with a note, and both kinds are reported in one run. Staged content counts; an edit left only in the working tree does not, and a commit time check covers that. `scripts/test-check-dashes.sh` is its self test. The `dashes` CI job runs the self test, then the check, and the check still reports when the self test fails. Both scripts are shared with ujira, ujira-contracts and ujira-docs, identical apart from the licence header, so a change is made in all four.

## Invisible characters

Literal bidirectional controls and invisible characters can make text read differently from what it is, and they do not show in review. `scripts/check-invisible-characters.py` reads the committed content of every tracked file, plus file names and symlink targets, prints each hit with its path, line and code point, and exits 1 on any. It rejects the Unicode categories Cf, Zl and Zp, control characters other than a tab, a line feed and a carriage return before a line feed, and the other default ignorable characters. Anything that needs one must write it as an escape.

It also rejects the look-alikes U+00A0, U+202F and U+2212, unless the file is listed in `scripts/invisible-characters-allowlist.txt`. Add a file there only with a reason in review.

Binary files are recognized by their content, not their name alone, and text hidden after a valid header is still read. The script is a copy of the one in `ujira-contracts`. `scripts/test-check-invisible-characters.sh` is its self test, and CI runs both in the `invisible-characters` job.

```sh
scripts/check-invisible-characters.py
scripts/test-check-invisible-characters.sh
```

CI pins the Unicode version the character tables must be, with `--unicode-version`. A local Python on a newer version is fine without the flag.

## Tool downloads

Every tool `.github/workflows/ci.yml` downloads retries with a time limit and is followed by its checksum check, so a passing 504 from a release host does not fail a job, and a retry never accepts whatever came back. `scripts/check-workflow-downloads.sh` fails on a `curl` that does not do both, and `scripts/check-workflow-downloads.test.sh` is its self test, including against a real server that answers 504. The same scripts are in `ujira`, `ujira-contracts`, `ujira-mcp` and `ujira-docs`, identical below the licence header.

## Pull requests

Every pull request starts from `.github/pull_request_template.md`: the linked issue, what and why, the tests run with their output, docs, a checklist, the reviews the change type needs, and the merge rules (squash only, and any commit after an approval needs review again). `scripts/check-pr-template.sh` fails if the template loses any of these or stops being plain ASCII, and `scripts/check-pr-template.test.sh` proves it; CI runs both. `.github/CODEOWNERS` names the owner of each top level path. It is advisory: on the current GitHub plan branch protection cannot require code owner review (qomiralabs/ujira#229).

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`, with read-only permissions. Its `checks` job runs the pull request template check and its self test. Its `secrets` job lints the workflows with actionlint and runs the secret scan below. Its `dashes` job runs the dash check described under Dashes. Every action is pinned to a full commit SHA, and actionlint and gitleaks are release binaries checked against a SHA-256 in the workflow; bump a version and its hash together.

## Secret scanning

The `secrets` job in `.github/workflows/ci.yml` runs `scripts/secret-scan.sh` with gitleaks 8.30.1 (MIT licensed), downloaded from its GitHub release and checked against a pinned SHA-256. It checks out the full history and scans every commit reachable from the checked out commit, not only the change, so a key that was committed and later deleted still fails. Merge commits are scanned against each parent, so a key added while resolving a merge is found, and every file is read as text, so a `.gitattributes` entry such as `-diff` or `binary` cannot hide one. The scan refuses a shallow clone and fails unless gitleaks reports scanning exactly the commits it should: every commit with a change in a file it does not delete (commits that only delete, rename or change a mode have nothing to scan). Findings are redacted in the log.

Two limits apply to any line based scanner. Binary files are handed to gitleaks as text, so a key stored as plain text inside one is found, but a compressed or encoded one is not; a commit that only adds binary files still passes. A token split across lines, or assembled from pieces in code, is not caught either. To cover the first, the scan also refuses, by name and in any case, any commit in the history that adds or changes a key or env file, binary or not: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.p8` and `.der` files, private ssh keys such as `id_rsa` or `id_ed25519` (their `.pub` halves are allowed), and `.env`, `.env.*`, `.envrc` and `*.env` files other than `.env.example`. Names are read unquoted, so non-ASCII names are checked too. Key material and environment values belong in the secret manager.

`.gitleaks.toml` holds the default rules of gitleaks 8.30.1 with upstream's global allowlist removed, so lockfiles, `node_modules`, images, `.pem`, `.key` and `.log` files, `go.sum` and files named `gitleaks.toml` are scanned like any other file. Upstream rule allowlists that list sample keys or passwords (for the GCP API key and NuGet password rules, and one hex stopword) are removed too. The rule allowlists that remain only drop placeholders, words and template syntax, and the self test scans the file with every allowlist stripped so no key shaped literal can return. Its header names the upstream file, its hash and every edit. Inline `gitleaks:allow` comments are ignored and any `.gitleaksignore` fails the scan, so `.gitleaks.toml` is the only allowlist. Each allowlist entry must cover a single synthetic test fixture and say why it is safe; path wide and rule wide exclusions are not allowed.

On pull requests the scan reads `.gitleaks.toml` from the base branch rather than from the change, so an edit to that file in a pull request does not change the rules that pull request is scanned with; the edit takes effect once it is merged. This is not a complete guarantee: a pull request can still edit `scripts/secret-scan.sh` or the workflow, and review is the control for those. A base branch without `.gitleaks.toml` gets the gitleaks built in default rules, never an empty set, and for that run upstream's global allowlist and its path skips apply again.

`scripts/secret-scan.test.sh` plants generated fake keys in throwaway repositories and checks that each one fails: in an ordinary commit, in a commit later deleted, behind `gitleaks:allow`, behind a `.gitleaksignore`, in a merge resolution, in files marked `-diff` or `binary`, in each path upstream skips (lockfiles, `node_modules`, `.svg`, a text `.png`, `.pem`, `.key`, `.log`, `go.sum`, any `gitleaks.toml`), and in a pull request that tries to replace the rules. It checks that key and env files are refused, also when removed later and with non-ASCII names, that `.pub` keys and `.env.example` pass, that delete only, rename only, mode only, binary, symlink and empty commits pass with the commit count matched exactly, and that `.gitleaks.toml` itself holds no key shaped literal. Both scripts run locally once gitleaks is installed (`brew install gitleaks`):

```sh
scripts/secret-scan.sh
scripts/secret-scan.test.sh
```

A manual run of gitleaks must pass the config as an absolute path, as `scripts/secret-scan.sh` does (`--config "$PWD/.gitleaks.toml"`, not `--config .gitleaks.toml`). When a relative config path matches the path of the file inside the repository, gitleaks silently skips findings in the config file itself.

Merging: this repository must stay squash-only. A pull request branch may hold commits, such as test probes or fixups, that never reach `development` only because every merge is a squash merge, and the scan on `development` relies on that. Enabling merge commits or rebase merging requires revisiting the secret scan first.

Keep `.env` files untracked; only `.env.example` belongs in git.
