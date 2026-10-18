# ujira-mcp
MCP server for UJIRA payouts, a thin adapter over the UJIRA API.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`, with read-only permissions. Its `secrets` job lints the workflows with actionlint and runs the secret scan below. Every action is pinned to a full commit SHA, and actionlint and gitleaks are release binaries checked against a SHA-256 in the workflow; bump a version and its hash together.

## Secret scanning

The `secrets` job in `.github/workflows/ci.yml` runs `scripts/secret-scan.sh` with gitleaks 8.30.1 (MIT licensed), downloaded from its GitHub release and checked against a pinned SHA-256. It checks out the full history and scans every commit reachable from the checked out commit, not only the change, so a key that was committed and later deleted still fails. Merge commits are scanned against each parent, so a key added while resolving a merge is found, and every file is read as text, so a `.gitattributes` entry such as `-diff` or `binary` cannot hide one. The scan refuses a shallow clone and fails unless gitleaks reports scanning at least every commit that adds a line of text (commits that only delete, rename or change a mode add nothing to scan). Findings are redacted in the log.

Two limits apply to any line based scanner. Binary files are handed to gitleaks as text, so a key stored as plain text inside one is found, but a compressed or encoded one is not; a commit that only adds binary files still passes. A token split across lines, or assembled from pieces in code, is not caught either. To cover the first, the scan also refuses any commit in the history that adds or changes a key file by name, binary or not: `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, and `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519` files (any case). Key material belongs in the secret manager.

`.gitleaks.toml` holds the default rules of gitleaks 8.30.1 with upstream's path based skips removed, so lockfiles, `node_modules`, images, `.pem`, `.key` and `.log` files, `go.sum` and files named `gitleaks.toml` are scanned like any other file; its header names the upstream file, its hash and the edits made. Inline `gitleaks:allow` comments are ignored and any `.gitleaksignore` fails the scan, so `.gitleaks.toml` is the only allowlist. Each allowlist entry must cover a single synthetic test fixture and say why it is safe; path wide and rule wide exclusions are not allowed.

On pull requests the scan reads `.gitleaks.toml` from the base branch rather than from the change, so a pull request cannot widen the allowlist or loosen the rules its own scan runs with; a change to the file takes effect once it is merged. A base branch without the file gets the gitleaks default rules, never an empty set. The workflow and the scan script still come from the change, so review remains the control for those.

`scripts/secret-scan.test.sh` plants generated fake keys in throwaway repositories and checks that each one fails: in an ordinary commit, in a commit later deleted, behind `gitleaks:allow`, behind a `.gitleaksignore`, in a merge resolution, in files marked `-diff` or `binary`, in each path upstream skips (lockfiles, `node_modules`, `.svg`, a text `.png`, `.pem`, `.key`, `.log`, `go.sum`, any `gitleaks.toml`), and in a pull request that tries to replace the rules. It checks that key files such as `.p12`, `.pfx`, `.jks` and `id_rsa` are refused, also when removed later, and that delete only, rename only, mode only, binary, symlink and empty commits pass. Both scripts run locally once gitleaks is installed (`brew install gitleaks`):

```sh
scripts/secret-scan.sh
scripts/secret-scan.test.sh
```

Keep `.env` files untracked; only `.env.example` belongs in git.
