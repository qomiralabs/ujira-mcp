# ujira-mcp

Mandate bound payouts on Stellar. A payout engine and an MCP server that let an agent key pay people in USDC only inside the limits a principal set on chain in a UJIRA mandate: a total budget, a per-payment cap, a per-recipient daily cap, an allowlist of recipients, an approval threshold and an expiry. The principal can pause or revoke the mandate at any time. Funds never leave the mandate except to an allowlisted recipient or back to the principal.

This package talks straight to Stellar testnet over Soroban RPC. It does not need the hosted UJIRA API. Testnet only for now.

## How a payout runs

1. **Quote.** `quote_payout` reads the mandate's config and state and predicts `allowed`, `approval_required` or `blocked`, with the contract's own reason (`payment_cap_exceeded`, `recipient_not_allowed`, `daily_cap_exceeded`, `budget_exceeded`, `mandate_paused` and so on). Nothing is spent.
2. **Request.** `request_payout` builds a `request_payout` call signed by the agent key. The payout ID is derived from the mandate and the task ID, and `task_ref` from the task ID, so the mandate never accepts the same task twice. A blocked request is confirmed by simulating it against the contract and is never sent.
3. **Approve (people only).** At or above the approval threshold the payout waits. An approver signs `approve` with their own key. This is deliberately not an MCP tool.
4. **Pay.** An approved payout is executed by the executor key through a rail. The `usdc` rail calls the mandate's `execute`, which transfers USDC to the recipient's Stellar account. Calling `request_payout` again with the same task after approval pays it, once.
5. **Receipt.** Every task gets one receipt in a local JSON log: task ID, recipient, amount in integer minor units, asset, rail, outcome (`paid`, `blocked`, `approval_required`, `approved_then_paid`), payout ID and transaction hashes. `list_receipts` with `verify` cross-checks each receipt against the mandate's payout record and the ledger.

Amounts are always whole minor units as strings. USDC has 7 decimals, so `"10000000"` is 1 USDC.

## Quickstart

You need Node 22 or later, and the [stellar CLI](https://developers.stellar.org/docs/tools/cli) for testnet keys.

### 1. Install

```sh
git clone https://github.com/qomiralabs/ujira-mcp.git
cd ujira-mcp
npm ci
npm run build
```

Once the package is on npm, `npx -y ujira-mcp` starts the server without a clone.

### 2. Testnet keys and a mandate

The server signs as an agent of a mandate. Create testnet keys with the stellar CLI and fund them from friendbot. Keep them outside any repository:

```sh
mkdir -p ~/.config/ujira-testnet/mine
stellar --config-dir ~/.config/ujira-testnet/mine keys generate agent --network testnet --fund
stellar --config-dir ~/.config/ujira-testnet/mine keys generate executor --network testnet --fund
```

The principal creates the mandate through the UJIRA factory on testnet, names your agent (and optionally your executor) in it, funds it with USDC and allowlists the recipients. `scripts/testnet/smoke.sh` in [ujira-contracts](https://github.com/qomiralabs/ujira-contracts) shows every step. Write the mandate's public facts to a `mandate.json`:

```json
{
  "network": "testnet",
  "mandate": "C...",
  "asset": { "code": "USDC" },
  "recipients": [{ "recipient_ref": "<64 hex digits>", "destination": "G..." }]
}
```

`recipients` maps each allowlisted destination to the `recipient_ref` the principal allowlisted it under. A destination without one uses the default reference `sha256("ujira-mcp/recipient/v1\n" + destination)`.

### 3. Configure

| Variable | Meaning |
| --- | --- |
| `UJIRA_MANDATE_FILE` | Path to `mandate.json`. Or set `UJIRA_MANDATE_ID` to the contract address. |
| `UJIRA_AGENT_KEY_FILE` | The agent key: a stellar CLI identity file (`seed_phrase` or `secret_key`) or a file holding an `S...` secret. Or `UJIRA_AGENT_SECRET`. |
| `UJIRA_EXECUTOR_KEY_FILE` | Optional executor key, same forms. Without it the agent key executes, which the mandate allows. |
| `UJIRA_RECEIPTS_FILE` | Optional. The receipt log, default `~/.ujira-mcp/receipts.json`. |
| `UJIRA_RPC_URL` | Optional. Another testnet RPC server. |
| `UJIRA_NETWORK` | Optional. Only `testnet` is accepted. |

Keys are read only from these settings, never from tool input, and no message the server writes contains one.

### 4. Run the demo

`examples/demo.ts` runs a dozen real testnet payouts through a demo mandate: normal payments, three blocked ones (over the per-payment cap, a recipient not on the allowlist, over the daily limit) and two that need approval, which the demo approves with the approver key before they are paid. It writes `evidence/testnet-run.json`, `evidence/RUN.md` and the receipt log `evidence/receipts.json`.

```sh
UJIRA_DEMO_DIR=~/.config/ujira-testnet/demo npm run demo
```

`UJIRA_DEMO_DIR` holds `mandate.json` with three recipients and the identities `stellar/identity/{agent,executor,approver}.toml`. Each can also be set on its own with `UJIRA_MANDATE_FILE`, `UJIRA_AGENT_KEY_FILE`, `UJIRA_EXECUTOR_KEY_FILE` and `UJIRA_APPROVER_KEY_FILE`.

### 5. Add the server to an MCP client

Claude Desktop (`claude_desktop_config.json`) or Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ujira": {
      "command": "npx",
      "args": ["-y", "ujira-mcp"],
      "env": {
        "UJIRA_MANDATE_FILE": "/home/you/.config/ujira-testnet/mine/mandate.json",
        "UJIRA_AGENT_KEY_FILE": "/home/you/.config/ujira-testnet/mine/identity/agent.toml",
        "UJIRA_EXECUTOR_KEY_FILE": "/home/you/.config/ujira-testnet/mine/identity/executor.toml"
      }
    }
  }
}
```

From a clone, use `"command": "node"` and `"args": ["/path/to/ujira-mcp/dist/mcp/main.js"]` instead. Use absolute paths; the client does not expand `~`.

## Tools

| Tool | Input | Answer |
| --- | --- | --- |
| `quote_payout` | `recipient`, `amount`, optional `rail`, `task_id` | `decision`, `reason`, headroom (cap, threshold, budget left, daily left, free funds) |
| `request_payout` | `task_id`, `recipient`, `amount`, optional `rail` | the receipt: `outcome`, `reason`, `payout_id`, `request_tx_hash`, `tx_hash` |
| `payout_status` | `task_id` | on-chain status (`pending`, `approved`, `executed`, `rejected`, `cancelled`, `not_found`) and the receipt |
| `list_receipts` | optional `task_id`, `outcome`, `limit`, `verify` | receipts newest first, and with `verify` a cross-check of each |

Every input schema is strict: an unknown field is refused by name and its value is never echoed.

## Rails

A rail decides which on-chain destination the mandate pays for a recipient and how an approved payout is settled (`src/rails/rail.ts`). `usdc` pays the recipient's Stellar account directly. Other rails, such as the Stellar Disbursement Platform, plug in through `createEngine(settings, { extraRails })`.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The unit tests run the engine, the codec and every MCP tool against a fake RPC that holds an in-memory mandate, so they need no network.

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
