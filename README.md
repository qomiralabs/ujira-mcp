# ujira-mcp
MCP server for UJIRA payouts, a thin adapter over the UJIRA API.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`, with read-only permissions. Its `secrets` job lints the workflows with actionlint and runs the secret scan below. Every action is pinned to a full commit SHA, and actionlint and gitleaks are release binaries checked against a SHA-256 in the workflow; bump a version and its hash together.

## Secret scanning

The `secrets` job in `.github/workflows/ci.yml` runs `scripts/secret-scan.sh` with gitleaks 8.30.1 (MIT licensed), downloaded from its GitHub release and checked against a pinned SHA-256. It checks out the full history and scans every commit reachable from the checked out commit, not only the change, so a key that was committed and later deleted still fails. The scan refuses a shallow clone, and fails unless gitleaks reports scanning as many commits as `git log --no-merges HEAD` lists with file changes (merge commits have no diff of their own). Findings are redacted in the log.

`.gitleaks.toml` extends the default gitleaks rules. Inline `gitleaks:allow` comments are ignored and any `.gitleaksignore` fails the scan, so the config is the only allowlist. Each allowlist entry must cover a single synthetic test fixture and say why it is safe; path wide and rule wide exclusions are not allowed. `scripts/secret-scan.test.sh` plants generated fake keys in throwaway repositories, including one deleted in a later commit, and checks that every one fails the scan.

Both run locally once gitleaks is installed (`brew install gitleaks`):

```sh
scripts/secret-scan.sh
scripts/secret-scan.test.sh
```

Keep `.env` files untracked; only `.env.example` belongs in git.
