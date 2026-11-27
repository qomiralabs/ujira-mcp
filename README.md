# ujira-mcp

Mandate bound payouts on Stellar. A payout engine and an MCP server that let an agent key pay people in USDC only inside the limits a principal set on chain in a UJIRA mandate: a total budget, a per-payment cap, a per-recipient daily cap, an allowlist of recipients, an approval threshold and an expiry. The principal can pause or revoke the mandate at any time. Funds never leave the mandate except to an allowlisted recipient or back to the principal.

This package talks straight to Stellar testnet over Soroban RPC. It does not need the hosted UJIRA API. Testnet only for now.

There are two ways to use it: add the hosted public demo to Claude or Cursor by URL (below), or run the server yourself over stdio or HTTP with your own mandate and keys.

## Use the hosted server

A public demo of the server runs on Stellar testnet at:

```
https://ujira.co/mcp
```

It needs no account, key or install. It is a **shared public testnet demo**: everyone who connects pays from the same demo mandate, signed by the same demo agent key, and `list_receipts` shows everyone's receipts, not only yours. Testnet tokens are not real money. Because task IDs and receipts are public, never put personal data in them.

The demo keeps strangers inside small limits, on top of the mandate's own rules:

- A payout or quote above 10 USDC is answered `blocked` with reason `public_demo_limit`, so a visitor never reaches the mandate's approval threshold. Nothing is sent.
- One address may call `request_payout` 5 times an hour, and the whole server answers at most 120 tool calls a minute. Past either, the tool answers `rate_limited`.
- Only recipients on the demo mandate's allowlist can be paid. The server lists them in its instructions and in the `request_payout` description. Anyone else is `blocked` with `recipient_not_allowed`.
- The SDP rail is not available on the hosted server; asking for it answers `rail_unavailable`.

### Claude (claude.ai and Claude Desktop)

1. Open **Settings**, then **Connectors**, and choose **Add custom connector**. Custom connectors need a Claude plan that allows them.
2. Name it `UJIRA demo` and paste `https://ujira.co/mcp` as the URL. Leave the OAuth fields empty; the demo has no sign in.
3. Choose **Add**. In a chat, turn the connector on from the tools menu, then ask, for example, "quote a 2 USDC payout to the first demo recipient, then pay it as task demo-1".

A connector added on claude.ai shows up in Claude Desktop under the same account, and the other way round.

### Cursor

Open **Settings**, then **MCP**, and add a server, or put this in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ujira-demo": { "url": "https://ujira.co/mcp" }
  }
}
```

### Check it from a shell

```sh
curl -s https://<your-app>.up.railway.app/healthz
curl -s https://ujira.co/mcp   -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## How a payout runs

1. **Quote.** `quote_payout` reads the mandate's config and state and predicts `allowed`, `approval_required` or `blocked`, with the contract's own reason (`payment_cap_exceeded`, `recipient_not_allowed`, `daily_cap_exceeded`, `budget_exceeded`, `mandate_paused` and so on). Nothing is spent.
2. **Request.** `request_payout` builds a `request_payout` call signed by the agent key. The payout ID is derived from the mandate and the task ID, and `task_ref` from the task ID, so the mandate never accepts the same task twice. A blocked request is confirmed by simulating it against the contract and is never sent.
3. **Approve (people only).** At or above the approval threshold the payout waits. An approver signs `approve` with their own key. This is deliberately not an MCP tool.
4. **Pay.** An approved payout is executed by the executor key through a rail. The `stellar.wallet` rail calls the mandate's `execute`, which transfers USDC to the recipient's Stellar account. Calling `request_payout` again with the same task after approval pays it, once.
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

`npx -y @ujira/mcp` starts the server without a clone (package `@ujira/mcp` on npm).

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
| `UJIRA_MANDATE_FILE` | Path to `mandate.json`. Or `UJIRA_MANDATE_JSON` with the same content inline, or `UJIRA_MANDATE_ID` with only the contract address. |
| `UJIRA_AGENT_KEY_FILE` | The agent key: a stellar CLI identity file (`seed_phrase` or `secret_key`) or a file holding an `S...` secret. Or `UJIRA_AGENT_SECRET`. |
| `UJIRA_EXECUTOR_KEY_FILE` | Optional executor key, same forms, or `UJIRA_EXECUTOR_SECRET`. Without it the agent key executes, which the mandate allows. |
| `UJIRA_RECEIPTS_FILE` | Optional. The receipt log, default `~/.ujira-mcp/receipts.json`. |
| `UJIRA_RPC_URL` | Optional. Another testnet RPC server. |
| `UJIRA_NETWORK` | Optional. Only `testnet` is accepted. |
| `UJIRA_DEMO_FEATURES` | `on` or `off`, default `off`. `on` runs the testnet demo: the public demo MCP at `/mcp`, the faucet and test recipients, the recycler and the SDP rail. The server refuses to start with it on unless `UJIRA_NETWORK=testnet` is set. https://ujira.co runs with it on. |

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
      "args": ["-y", "@ujira/mcp"],
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

## Self host

`ujira-mcp` serves stdio for a client on the same machine. `ujira-mcp-http` serves the same four tools over MCP Streamable HTTP for a public URL: `POST /mcp` (stateless, JSON responses, no auth) and `GET /healthz`. It is built to be left open to anyone, so it always applies the public limits above, and its tool descriptions say the demo is shared.

### Run it

```sh
npm ci && npm run build
UJIRA_MANDATE_FILE=/path/to/mandate.json UJIRA_AGENT_KEY_FILE=/path/to/agent.toml UJIRA_RECEIPTS_FILE=/path/to/receipts.json node dist/server/main.js
```

`node dist/mcp/http-main.js` (the `ujira-mcp-http` command) still starts the web role on its own.

Or with Docker. The image runs the server as the `node` user and keeps receipts in `/data`, so mount a volume there:

```sh
docker build -t ujira-mcp .
docker run --rm -p 8080:8080 -v ujira-data:/data   -e UJIRA_MANDATE_JSON="$(cat mandate.json)"   -e UJIRA_AGENT_SECRET -e UJIRA_EXECUTOR_SECRET   ujira-mcp
```

`-e UJIRA_AGENT_SECRET` with no value passes the variable from your shell, so the key never appears on the command line.

### Roles

One image, and one entry point (`dist/server/main.js`, `npm start`), runs the roles named in `UJIRA_ROLES`:

| `UJIRA_ROLES` | Runs |
| --- | --- |
| unset or empty | `web,worker`, both in one process. The Railway service runs this, so a deploy that does not set the variable serves exactly as before. |
| `web` | The site, `/app`, `/api`, `/mcp`, `/m/<mandate>/mcp` and `/healthz`: everything the HTTP server has always served. |
| `worker` | Queued jobs only, with no HTTP listener and none of the web settings. It has no tasks yet; it starts, stays up and stops cleanly. |
| `web,worker` | Both. Order and spaces do not matter. |

Anything else, such as a typo, an empty entry or a role named twice, refuses to start with exit code 1 and a message such as `ujira-server: UJIRA_ROLES must be web, worker or web,worker; "jobs" is not a role`.

On SIGTERM or SIGINT the web role stops first: it stops taking connections at once, gives requests in flight up to 10 seconds, then closes the rest. The worker stops next. The whole stop has a 20 second budget; the process exits 0 when every role stopped in time and 1 when one did not, and a second signal while stopping changes nothing. The image's health check asks `/healthz` unless the container runs the worker role alone, which has no port; a host running a worker alone needs no HTTP health check either.

### Deploy on Railway

`.railway/railway.ts` is the service's Railway configuration as code: it builds the `Dockerfile`, checks `/healthz` (60 second timeout) before a deploy goes live, restarts the server on failure up to 10 times, mounts the volume at `/data` and serves `ujira.co` and `www.ujira.co` on port 8080. Variables, which hold the keys and the mandate, are left unmanaged and stay in Railway. It replaced `railway.json`, which Railway stops reading on 2026-12-01. After `npm ci`, preview a change with `railway config plan` and apply it with `railway config apply`; for your own deployment, change the project, volume and domain names in that file first. The server listens on `PORT`, 8080 in the image.

```sh
railway init
railway volume add --mount-path /data
railway variables --set "UJIRA_MANDATE_JSON=$(cat mandate.json)"
railway variables --set "UJIRA_AGENT_SECRET=..." --set "UJIRA_EXECUTOR_SECRET=..."
railway up
railway domain
```

Use testnet keys only. Keep the agent key's mandate small: whoever holds the URL can spend from it up to the public cap.

### HTTP settings

The mandate and key settings are the ones under Configure. These are for the HTTP server only.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `UJIRA_HTTP_HOST` | `0.0.0.0` | Address to listen on. |
| `UJIRA_RECEIPTS_FILE` | `/data/receipts.json` in the image | The shared receipt log. Put it on a volume. The server refuses to start if it cannot write there. |
| `UJIRA_PUBLIC_MAX_AMOUNT` | `100000000` (10 USDC) | The largest payout a caller may ask for, in minor units. Keep it below the mandate's approval threshold. |
| `UJIRA_PAYOUTS_PER_HOUR` | `5` | `request_payout` calls an hour from one address (an IPv6 caller counts by its /64). |
| `UJIRA_TOOL_CALLS_PER_MINUTE` | `120` | Tool calls a minute from everyone together. |
| `UJIRA_MAX_BODY_BYTES` | `65536` | Larger request bodies get 413. |
| `UJIRA_HTTP_TIMEOUT_MS` | `120000` | A request still unanswered after this gets 504. A payout that was already sent still finishes, and calling `request_payout` again with the same task ID picks it up without paying twice. |
| `UJIRA_ALLOWED_ORIGINS` | none | Browser origins to allow besides `https://claude.ai` and `https://claude.com`, comma separated. Requests without an `Origin` header, such as from Cursor or a server, are always allowed. Any other origin gets 403. |
| `UJIRA_TRUST_PROXY` | `1` | Read the caller's address from a proxy header. Set `0` when the server faces the internet directly, or callers can pick their own address. |
| `UJIRA_CLIENT_IP_HEADER` | none | The one header holding the caller's address, such as `Fly-Client-IP`. Unset, `X-Real-IP` is read and then the last `X-Forwarded-For` entry. |

`/mcp` is the public demo and answers only with `UJIRA_DEMO_FEATURES=on`; otherwise it is a 404. The SDP rail runs only with the demo on and `UJIRA_SDP_URL` and its companions set; otherwise a call that asks for it answers `rail_unavailable`. Errors never carry a stack trace.

### Logs, health and alerts

`ujira-mcp-http` writes one JSON object per line on stdout: `time`, `level`, `service`, `event`, a readable `message`, then the fields of the event. Every request gets a `requestId`, which `/v1` also returns as `Ujira-Request-Id`; every line written while the request runs carries it, and every line about a payout carries its `payoutId`, so `@payoutId:<id>` or `@requestId:<id>` in the Railway log search finds the whole story (`principalId` and `projectId` join them once callers sign in). Each request logs `event=http_request` with the method, the route (never the raw path), the status and the time; each payout logs `payout_requested`, one `payout_recorded` per step with its outcome and transaction hashes, or `payout_request_failed` with an error code.

All lines pass through one sink (`src/log.ts`) that drops fields named like secrets or personal data (keys, tokens, signatures, envelopes, cookies, sessions, emails, labels, recipients, destinations, addresses) and scrubs every value and every free text line of Stellar secret seeds, API keys, bearer tokens, JWTs, credentials in URLs, emails, phone numbers, IP addresses and long base64 or hex runs such as signatures. Stellar account addresses are shortened to `GABC...WXYZ`; contract ids, transaction hashes and payout ids are kept.

`GET /healthz` stays a shallow `{"status":"ok"}` for the platform's restart check. `GET /healthz/deep` asks the database (an empty transaction on the app login, when `UJIRA_DB_APP_URL` is set), the chain RPC, the worker heartbeat and the last reconcile run, each within 2 seconds, and shares one round of answers for 5 seconds. It answers `ok`; `degraded` with 200 when only the RPC fails or the worker or reconcile is late; and `down` with 503 when the database fails. A part the process does not run reads `not_configured` and does not lower the status. Answers name error codes only.

Alert lines are written at level `error` with `alert` set to their name, so a log alert can match `@alert:executor_low`:

| Alert | When |
| --- | --- |
| `payout_dead_letter` | A payout job failed its last attempt and the payout needs a person. The job worker writes it with `deadLetterLine` from `src/worker/alerts.ts`; until the worker runs, nothing does. |
| `executor_low` | The executor account has under 50 XLM, or does not exist; checked every 15 minutes. |
| `fee_sponsor_low` | The fee sponsor (`UJIRA_FEE_SPONSOR_*`) has under 50 XLM, or does not exist; checked every 15 minutes. |
| `reconcile_stale` | The reconcile sweep has not run for 6 minutes; checked every minute, once the sweep registers its heartbeat. |

### Console

The same server hosts the UJIRA dashboard (the console): a web app where anyone with a testnet wallet creates and runs their own mandate. It serves the built UI (`console/dist`) at `/app`, a JSON API under `/api`, and an MCP URL per console mandate at `/m/<mandate>/mcp`. The server never sees a wallet's key: it builds unsigned transactions, the wallet signs, and the server relays only the transactions it would have built (the factory's `create` with this server's agent and executor, owner calls on a mandate it created, a USDC transfer into one, or a USDC trustline). Console mandates use the same engine, rails and receipt log as `/mcp`.

The faucet, test recipients, the recycler and the SDP rail are the demo's, so the settings marked demo apply only with `UJIRA_DEMO_FEATURES=on`. Without it, `/api/onboard/*` and `/api/recipients/test` are a 404 and `/api/config` reports the faucet and SDP off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UJIRA_DATA_DIR` | the directory of `UJIRA_RECEIPTS_FILE`, else `./data` | Where the console registry (mandates it created, recipient names, last faucet top up per wallet) and the test recipients' keys (`test-wallets.json`, mode 600) are kept. Put it on a volume. |
| `UJIRA_TREASURY_SECRET` or `UJIRA_TREASURY_KEY_FILE` | none | Demo. The key that pays test USDC from the faucet. Without it the faucet and the recycler are off, and test recipients' keys are not kept. |
| `UJIRA_FAUCET_AMOUNT` | `500000000` (50 USDC) | Demo. The faucet's target, in minor units: a top up sends the target minus what the wallet holds, and nothing when it holds the target or more. |
| `UJIRA_FAUCET_COOLDOWN_SECONDS` | `600` | Demo. The least time between two top ups of one wallet. Earlier asks answer `faucet_cooldown` with `retryAfterSeconds`. |
| `UJIRA_FAUCET_FLOOR` | twice the amount | Demo. The faucet refuses once the treasury would drop below this. |
| `UJIRA_FAUCET_PER_HOUR` | `3` | Demo. Faucet top ups an hour from one caller address. |
| `UJIRA_RECYCLE_INTERVAL_SECONDS` | `300` | Demo. How often each test recipient sends its whole USDC balance back to the treasury, paying its own fee. Only wallets this server made are swept; past 5000 the oldest are dropped from recycling. |
| `UJIRA_TEST_RECIPIENTS_PER_HOUR` | `10` | Demo. Test recipient wallets an hour from one caller address. |
| `UJIRA_FRIENDBOT_PER_HOUR` | `10` | Demo. Test XLM requests an hour from one caller address. |
| `UJIRA_API_CALLS_PER_MINUTE` | `240` | API calls a minute from one caller address. |
| `UJIRA_MANDATE_PAYOUTS_PER_HOUR` | `30` | Payout requests an hour on one console mandate, from the console and its MCP URL together. |
| `UJIRA_PUBLIC_ORIGIN` | from the request | The origin used in each mandate's MCP URL, such as `https://ujira.co`. Unset, it comes from `Host` and, with `UJIRA_TRUST_PROXY`, `X-Forwarded-Proto`. |
| `UJIRA_SIGN_IN` | `off` | `on` serves wallet sign in on `/v1` (`auth/challenge`, `auth/session`, `me`) and the principal and project routes (`principals`, `projects`), and makes `/api/config` report `signIn: true`, so the dashboard asks people to sign in. It needs `UJIRA_PUBLIC_ORIGIN` set to the https origin the dashboard is served from, the `UJIRA_DB_*` URLs, and the migrations applied. The session is an HttpOnly, Secure, SameSite=Lax `ujira_session` cookie on `/v1`; only its SHA-256 is stored. |
| `UJIRA_CONSOLE_DIR` | `console/dist` in the package | The built dashboard, served under `/app`. |
| `UJIRA_SITE_DIR` | `site` in the repository | The marketing site and the testnet proof page, served at the root. |
| `UJIRA_EMBED_DIR` | `embed/dist` in the repository | The built recipient widget, served under `/embed/v1/`. |
| `UJIRA_CANONICAL_HOST` | none | A host name such as `ujira.co`. When set, a page asked for on any other host (the platform URL, `www`) gets a 301 to `https://<host>` with the same path and query. `/api`, `/v1`, `/mcp`, `/m/<mandate>/mcp`, `/embed/v1/*` and `/healthz` keep answering on every host, so connectors and pages already pointed at an old URL keep working. Set it only once that host serves HTTPS. |
| `UJIRA_SDP_PROOF_URL` | `/instaward` | Demo. Where the dashboard links for proof of the SDP rail: a path on this server or an http or https URL. |
| `UJIRA_HORIZON_URL`, `UJIRA_FRIENDBOT_URL`, `UJIRA_PUBLIC_RPC_URL` | the public testnet ones | Network endpoints; the public RPC URL is the one browsers are told about. |
| `UJIRA_FACTORY`, `UJIRA_USDC_ISSUER`, `UJIRA_USDC_CONTRACT` | the testnet deployment | The mandate factory and the USDC the console uses. |

#### Keeping mandate entries alive

Soroban storage lives a set number of ledgers and is then archived, and the next transaction that touches an archived entry pays to restore it first. A mandate's money sits in the USDC contract's balance entry for the mandate, with its own lifetime, and the mandate never extends its allowlist or day usage entries itself. So the server runs a keep alive pass a minute after start and then every interval: for the demo mandate, every console mandate that is not revoked or expired, and the factory, it reads the live time to live of the instance, the code, the balance entry, and the allowlist and day usage entries of the recipients it knows, extends only those under the threshold, and restores any that are archived. Payout records are left to archive once their payout is over. Each run logs `event=mandate_entry_archived`, `event=mandate_entry_restored`, `event=mandate_entry_extended` with the transaction hash, and a closing `event=mandate_keepalive_run` line. While an entry stays archived, `GET /api/mandates/<mandate>` carries a `ledger_entries_archived` warning. A run reads before it sends, so a repeated run sends nothing.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UJIRA_FEE_SPONSOR_SECRET` or `UJIRA_FEE_SPONSOR_KEY_FILE` | none | The account that pays for extensions and restores, as the transaction's source. Without it the pass only reads, logs and warns. |
| `UJIRA_KEEPALIVE` | `on` | `off` stops the pass. |
| `UJIRA_KEEPALIVE_THRESHOLD_LEDGERS` | `345600` (20 days) | An entry with fewer ledgers left is extended. |
| `UJIRA_KEEPALIVE_EXTEND_TO_LEDGERS` | `1036800` (60 days) | How far ahead an extended entry then lives. Above the threshold and below the network's 3110400. |
| `UJIRA_KEEPALIVE_INTERVAL_SECONDS` | `86400` | Time between passes. |
| `UJIRA_KEEPALIVE_MANDATES_PER_RUN` | `200` | Mandates read in one pass; the rest get their turn on the next, round robin. |
| `UJIRA_KEEPALIVE_TRANSACTIONS_PER_RUN` | `50` | Transactions one pass may send; what is left waits for the next. |
| `UJIRA_KEEPALIVE_KEYS_PER_TRANSACTION` | `25` | Entries in one transaction. |

`UJIRA_TESTNET=1 npx vitest run test/keep-alive.testnet.test.ts` prints the live numbers for the demo mandate and the factory; add `UJIRA_TESTNET_KEEPALIVE_SEND=1` and a fee sponsor key to run one paid pass.

#### Fee sponsorship

Principals never need XLM. Every transaction a principal signs through UJIRA (create, fund, allow recipients, pause, resume, revoke, approve, reject, withdraw) is sent inside a fee bump that the fee sponsor pays. The principal's own envelope is checked against the signing request it was built from before anything is reserved or sent.

Each principal may use the sponsor up to a daily cap, counted across all of its projects for the UTC day and kept in Postgres, so every instance sees the same total. A transaction reserves the fee bump's maximum before it is sent and is settled at what the network charged once it is final; one the network refused without applying is released. Retrying the same signed envelope counts once. Past the cap nothing is sent: the API answers `429 RATE_LIMITED` with `Retry-After` set to the seconds left in the UTC day, and the server logs `event=fee_sponsor_cap_reached`. The sponsor's own balance is watched by the `fee_sponsor_low` alert above.

| Variable | Default | Meaning |
| --- | --- | --- |
| `UJIRA_FEE_SPONSOR_SECRET` or `UJIRA_FEE_SPONSOR_KEY_FILE` | none | The fee sponsor, the same account the keep alive pass pays from. Without it a principal pays its own fee. |
| `UJIRA_FEE_SPONSOR_DAILY_CAP` | `50000000` (5 XLM) | Stroops the sponsor pays for one principal in one UTC day. A testnet mandate create costs about 0.13 XLM. |

`UJIRA_TESTNET=1 UJIRA_FEE_SPONSOR_KEY_FILE=... npx vitest run test/fee-sponsorship.testnet.test.ts` makes a principal that holds only its reserve and has it sign a mandate create, sent with the sponsor paying.

Every page of the product is served from this one server:

| Path | Serves |
| --- | --- |
| `/` | The marketing site (`site/index.html`). |
| `/instaward` | The testnet proof page (`site/instaward.html`). |
| `/assets/*`, `/data/*` | The site's images, scripts and evidence files. |
| `/app`, `/app/*` | The dashboard. Hashed files under `/app/assets/` are cached for a year; any other path under `/app` that is not a file gets the dashboard's `index.html`, so its own routes survive a reload. |
| `/embed/v1/ujira-embed.js` | The recipient onboarding widget (`embed/`), for any page to load: CORS open, cached for a day and served stale for a week while it revalidates. The path carries the major version, so a breaking change ships beside it as `/embed/v2/`. Any other path under `/embed` is a 404. |
| `/api/*`, `/mcp`, `/m/<mandate>/mcp`, `/healthz` | The API and MCP routes above. |
| `/v1/*` | The public API, described below. Like `/api`, it answers on every host. |

Old links get a 301: `/instaward.html` to `/instaward`, `/index.html` to `/`, `/app.html` to `/app`, `/?mock=1` to `/app?mock=1`, `/new` to `/app/mandates/new`, and dashboard sections at the root (`/mandates/...`, `/approvals`, `/payouts`, `/receipts`, `/recipients`, `/developers`) to the same path under `/app`. The console once kept its page in the hash (`/#/m/<mandate>`), which a server never sees, so the marketing page forwards those links to `/app` itself. Any other path is the site's 404 page. Pages are read only from inside their folder: a path with a `..` or hidden segment, a backslash or a NUL is a 404, and folders are never listed.

The faucet tops a wallet up rather than paying once, so a reviewer who spent their test USDC can always get more, and the test money flows back: a test recipient made by "Add a test recipient" is a throwaway wallet the server created, and the recycler returns whatever it is paid to the treasury. Its key is kept only in `test-wallets.json`, never logged and never returned by any route; the reviewer's own wallet key never reaches the server at all.

With SDP configured, the console allows each recipient twice, once at their own wallet and once at the SDP distribution account, so the same mandate pays on either rail. `UJIRA_SDP_ASSET_ISSUER` must then be the console's USDC issuer.

`UJIRA_CONSOLE_URL=http://127.0.0.1:8080 npm run console:e2e` walks the whole console story against a running server with a throwaway wallet that signs the server-built transactions: onboard, create, allow, fund, pay, an approval, SDP when the server has it, pause and resume, receipts over the API and the mandate's MCP URL, then revoke and sweep, then waits for the test recipient's USDC to be recycled to the treasury and for the faucet cooldown, and tops up again. It saves the public transaction hashes to `evidence/console-e2e.json`.

### Public API (`/v1`)

The versioned public API is being built under `/v1`, beside the routes above, which it does not change. Today it serves `GET /v1/ping` and `GET /v1/openapi.json`, the OpenAPI 3.1 document generated from the route schemas.

- Every answer carries a `Ujira-Request-Id` header. Quote it when asking for support; every server log line written for the request carries it as `requestId`.
- Every failure is `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. A schema failure adds `details`, which names paths and issue kinds, never the values sent.
- Bodies are JSON (`Content-Type: application/json`) and at most 64 KB: a larger one answers `413 PAYLOAD_TOO_LARGE`, another type `415 UNSUPPORTED_MEDIA_TYPE`.

## Tools

| Tool | Input | Answer |
| --- | --- | --- |
| `quote_payout` | `recipient`, `amount`, optional `rail`, `task_id` | `decision`, `reason`, headroom (cap, threshold, budget left, daily left, free funds) |
| `request_payout` | `task_id`, `recipient`, `amount`, optional `rail` | the receipt: `outcome`, `reason`, `payout_id`, `request_tx_hash`, `tx_hash` |
| `payout_status` | `task_id` | on-chain status (`pending`, `approved`, `executed`, `rejected`, `cancelled`, `not_found`) and the receipt |
| `list_receipts` | optional `task_id`, `outcome`, `limit`, `verify` | receipts newest first, and with `verify` a cross-check of each |

Every input schema is strict: an unknown field is refused by name and its value is never echoed.

## Rails

A rail decides which on-chain destination the mandate pays for a recipient and how an approved payout is settled (`src/rails/rail.ts`). Rails have dotted ids. `stellar.wallet` pays the recipient's Stellar account directly and is the only rail product mandates use. `demo.sdp`, the Stellar Disbursement Platform, pays the person from a distribution account UJIRA controls, so it is a testnet demo feature only, in `src/demo`, and goes before mainnet. Other rails plug in through `createEngine(settings, { extraRails })`.

The rails' old names, `usdc` and `sdp`, are still accepted as `rail` in every tool and in the console API, so connectors set up before the rename keep working. Answers name the rail by its id, except the console API, which keeps the old names for the dashboard. The receipt file keeps the old names too, so a build from before the rename can still read it.

Nothing outside `src/demo` imports from it; a lint rule refuses it, and only the entry points (`src/mcp/main.ts`, `src/mcp/http-main.ts`, `src/server/`) compose the demo, and only when `UJIRA_DEMO_FEATURES` is on.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

The unit tests run the engine, the codec and every MCP tool against a fake RPC that holds an in-memory mandate, so they need no network. `test/server-process.test.ts` runs `src/server/main.ts` as a child process to check the roles, the signals and the exit codes.

### Local Postgres

`docker-compose.yml` holds a Postgres 17 for local runs and the database tests, pinned by digest and published on `127.0.0.1` only:

```sh
docker compose up --detach --wait db   # start it and wait until it is healthy
docker compose down                    # stop it; add --volumes to delete its data
```

Its login, password and database are all `ujira`, fixed local values that no real database uses, on port 54329 so it never clashes with another Postgres on 5432 (set `UJIRA_DB_PORT` to move it). Point the database settings at it:

| Variable | Local value |
| --- | --- |
| `UJIRA_DB_MIGRATOR_URL` | `postgresql://ujira:ujira@127.0.0.1:54329/ujira` |
| `UJIRA_DB_APP_URL` | `postgresql://ujira:ujira@127.0.0.1:54329/ujira` |
| `UJIRA_DB_WORKER_URL` | `postgresql://ujira:ujira@127.0.0.1:54329/ujira` |

The local server has no TLS certificate, so turn TLS off in the database settings when you point them at it. The `ujira` login owns the database and is a superuser, so it bypasses row level security: use it to migrate and to create the test databases, never to prove tenant isolation. The app connects as `ujira_app` (section 8.3 of `docs/adr/0001-product-base.md`), a login the migrations create without a password; give it a local password with `ALTER ROLE` and point `UJIRA_DB_APP_URL` at it, and do the same for the worker's login and `UJIRA_DB_WORKER_URL`. The `local-db` CI job starts this service and logs in from the host with the URL above.

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

`.github/workflows/ci.yml` runs on every pull request and on pushes to `development`, `staging` and `main`, with read-only permissions. Its `checks` job runs the pull request template check and its self test. Its `secrets` job lints the workflows with actionlint and runs the secret scan below. Its `dashes` job runs the dash check described under Dashes. Its `server` job installs from the lockfile with no install scripts, then runs `tsc`, eslint with zero warnings, the prettier check, vitest with coverage and `npm audit --omit=dev`. Its `console` job does the same in `console/` (vitest without coverage), then the production `vite build`, the license allowlist and the production audit. Its `console-e2e` job builds the console and runs its Playwright flows in mock mode at 375, 768 and 1440 wide in light and dark, with the Chromium build the locked Playwright release names, and keeps the screenshots as the `console-screenshots` artifact for 14 days. Its `image` job builds the `Dockerfile` and runs `scripts/check-image.sh` against it, which starts the image with each value of `UJIRA_ROLES` and checks `/healthz`, the missing listener of the worker role, the refusal of an unknown role and a clean stop within 20 seconds, web first; it makes a throwaway unfunded key for the run and never prints it. Its `local-db` job starts the Postgres in `docker-compose.yml` and logs in from the host. Its `embed` job does what the `console` job does in `embed/`, where the build also fails when `ujira-embed.js` and its chunks are over 60 KB gzipped, then runs the Playwright and axe browser tests against the built file. The server, console and embed jobs run on Node 22, the line the image runs, at the exact version in `NODE_VERSION`. Once the install succeeds, every later step reports even when an earlier one fails. Every action is pinned to a full commit SHA, and actionlint and gitleaks are release binaries checked against a SHA-256 in the workflow; bump a version and its hash together.

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
