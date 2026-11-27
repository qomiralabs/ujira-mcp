# ADR 0001: this repository is the UJIRA product base

- Status: accepted
- Date: 2026-11-26
- Scope: the server, the console at `/app`, the payout engine, the MCP server, the embed widget and the database, all in `qomiralabs/ujira-mcp`
- Contracts it owns: the chain adapter interface, the public API `/v1` and its versioning, and the payout status model. The mandate spec stays in `qomiralabs/ujira-contracts` and does not change here.

## 1. Problem

Two codebases exist.

- This repository runs at https://ujira.co: a Node HTTP server, the Vite and React console at `/app`, a payout engine that requests and executes payouts through the deployed Soroban mandate contracts, the MCP server, a faucet and an SDP rail. It keeps its state in three JSON files on a Railway volume (`console-registry.json`, `receipts.json`, `test-wallets.json`). It has no sign in, no tenants, no database and no queue. Every console mandate is driven by one shared agent key.
- The `qomiralabs/ujira` monorepo holds a deeper backend: a Postgres schema with 71 migrations, row level tenant security, API tokens, HTTP idempotency, a Hono API, a chain adapter, receipts, identity and a Lit embed widget. Its payout worker, member sessions, fee stack and dashboard screens sit in 37 open pull requests, and nothing in it runs anywhere.

We need a real testnet product in three to four weeks: principals who sign in, projects with tenant isolation, mandates, a payouts API with API keys and idempotency, a payout worker, USDC payouts to Stellar wallets with receipts, the dashboard, recipient onboarding through the embed widget, Postgres with backups, and hosting. Then mainnet readiness. We cannot finish both codebases, so we pick one base and port from the other.

## 2. Options

### 2.1 The product base

| Option                                         | For                                                                                                                                                                                 | Against                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Grow this repository and port what it lacks | It is live, on the domain, deployed by a working pipeline, and its console is the look the owner approved. Its engine has paid real testnet payouts through the deployed contracts. | It has no persistence, auth or tenancy, so those must be ported or written.                                                                                                                                                                              |
| B. Finish the monorepo and retire this one     | Deeper schema and more tested backend code.                                                                                                                                         | Its worker, sessions and dashboard are unmerged stacks of 6,000 to 20,000 lines each, built for anchor, fee and funding account features that are out of this window. It has never been deployed. Its CI has hit billing limits as a private repository. |
| C. Start a third repository that merges both   | Clean layout.                                                                                                                                                                       | Pays the cost of A and B together, and throws away the live deployment.                                                                                                                                                                                  |

### 2.2 Persistence

| Option                                                                         | For                                                                                                                                                                                                                                                                    | Against                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Keep the JSON files                                                         | Nothing to build.                                                                                                                                                                                                                                                      | One process, whole file rewrites, no tenancy, no unique constraints, no backups beyond the volume. It cannot meet the data rules.                                                                                                                                |
| B. Port all 71 monorepo migrations as they are                                 | Tested together.                                                                                                                                                                                                                                                       | They enforce invariants that need machinery we are not porting: mandate instances that only the chain indexer may activate, payout attempts tied to the fee stack, funding accounts and sweeps, compliance marks. We would have to port the monorepo worker too. |
| C. Port the foundation verbatim, write the domain tables new in the same shape | The tenancy, money, token, idempotency and audit layers are self contained and already proven. The domain tables keep the monorepo column names and composite tenant keys, so its later features (attempts, fees, funding accounts) can arrive as additive migrations. | The new domain migrations need their own tests.                                                                                                                                                                                                                  |

### 2.3 The dashboard stack

| Option                                 | For                                                                                                                                 | Against                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A. Keep the Vite and React console     | Live, approved look, already talks to wallets and signs mandate actions. Static files served by the same server, no second runtime. | No server rendering.                                                                                                         |
| B. Port the monorepo Next.js dashboard | Matches the original plan.                                                                                                          | A second runtime and deploy target, a different look the owner rejected, and screens that were never wired to a running API. |

### 2.4 The HTTP layer for `/v1`

| Option                                                        | For                                                                                                                                                                             | Against                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A. Mount a Hono app for `/v1` inside the existing Node server | The monorepo API middleware (token auth, idempotency, rate limits, error envelope, OpenAPI) is written for Hono and ports with little change. The existing routes keep working. | Two routing styles side by side until the console routes move to `/v1`. |
| B. Extend the hand written router                             | One style.                                                                                                                                                                      | Rewrites the middleware we would otherwise port.                        |

### 2.5 App hosting

| Option             | For                                                                             | Against                                                                                  |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A. Stay on Railway | Live today with `ujira.co`, TLS and a volume. Deploys from a Dockerfile.        | Not the host the original plan named.                                                    |
| B. Move to Render  | The host the plan named, where the testnet SDP already runs on company credits. | A move in the middle of the build, a domain and TLS cutover, and no gain in this window. |

### 2.6 How principals sign in

| Option                                                                             | For                                                                                                                                                                              | Against                                                                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A. Sign a one time message with the Stellar wallet (SEP-53), then a server session | Principals already connect Freighter or Albedo to sign every mandate action. No passwords, no email provider, no second factor to build now. The monorepo has a SEP-53 verifier. | A lost wallet loses dashboard access until another member is added. Wallet message signing needs checking in both wallets. |
| B. Email and password with TOTP                                                    | Familiar.                                                                                                                                                                        | Needs an email provider, password storage, recovery and MFA: the monorepo member stack is 8,000 lines and unmerged.        |
| C. Passkeys                                                                        | Strong and phishing resistant.                                                                                                                                                   | The passkey wallet flow is P1 and browser support needs its own spike.                                                     |

### 2.7 Agent keys

| Option                                                         | For                                                                                                            | Against                                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. One shared agent key for every mandate, as today            | Nothing to build.                                                                                              | Isolation between principals rests only on our application code: a bug that picks the wrong mandate row could request a payout on another principal's mandate. |
| B. One agent key per project, named in that project's mandates | The chain itself refuses project B's key on project A's mandate, so isolation holds even if our code is wrong. | Key generation, encryption at rest and funding per project.                                                                                                    |

### 2.8 Where the worker runs

| Option                                                   | For                                                                                                     | Against                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Same image, two roles, both in one service on testnet | One deploy, one bill. The worker scales out later by starting the same image with only the worker role. | A web deploy restarts the worker. Graphile Worker releases or retries the jobs, and every job is idempotent, so this costs time, not money. |
| B. A separate worker service now                         | Independent scaling and deploys.                                                                        | A second paid service before we have load that needs it.                                                                                    |

## 3. Decision

1. This repository is the product base (2.1 A). New product work lands here. The monorepo is a source to port from and is not built further as its own product.
2. Postgres is the system of record, with Graphile Worker for queued work (2.2 C). The monorepo database foundation is ported verbatim; the domain tables are new migrations in the monorepo's shape.
3. The dashboard stays the Vite and React console at `/app` (2.3 A).
4. The public API is versioned REST at `/v1`, a Hono app mounted in the existing server, with OpenAPI generated from the route schemas (2.4 A).
5. Hosting stays on Railway for the testnet launch (2.5 A). The mainnet host is decided before mainnet.
6. Principals sign in with a SEP-53 message signed by their Stellar wallet and hold an HttpOnly server session (2.6 A). Email, TOTP, invitations and passkeys come after the testnet launch.
7. Every project gets its own agent key, generated by UJIRA, encrypted at rest, and named as the agent in that project's mandates (2.7 B). One UJIRA executor key executes approved payouts for every mandate; it can only pay the legs the mandate recorded.
8. One image runs as `web`, `worker` or both (2.8 A). Testnet runs both in one service.
9. Funding at launch is a USDC transfer to the mandate contract from the principal's wallet. Fee bump sponsorship covers the network fee of every transaction a principal signs through UJIRA.
10. The SDP rail leaves the product money path. It pays the person from an SDP distribution account that UJIRA controls, which would hold principal funds between two transfers, and UJIRA is non-custodial. It stays as a demo feature only, behind `UJIRA_DEMO_FEATURES`, and is removed before mainnet.
11. Local-currency payouts are out of this build; a partner will supply them. The rail interface stays open so a partner rail plugs in without changing the payout model, the API or the receipts.
12. The testnet take rate is zero. The fee field exists on payouts, legs and receipts from day one, so the fee stack ports as an additive change before mainnet.

## 4. What this changes from the original plan

| Original plan                                                           | Now                                                                                                        | Why                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Next.js dashboard and website in the monorepo                           | Vite and React console at `/app`, static site in `site/`                                                   | 2.3. Live and approved; no second runtime.                                  |
| App hosting on Render                                                   | Railway for the testnet launch                                                                             | 2.5. Live today; a move gains nothing in this window.                       |
| The monorepo as the product, this repository as a published MCP package | This repository is the product; the monorepo is a port source                                              | 2.1.                                                                        |
| The MCP server is a separate package published from the monorepo        | The MCP server lives here and calls the same service layer as `/v1` in process                             | One codebase; the tools and the API share the code that enforces the rules. |
| `packages/ui` shared design system with Storybook                       | Console components in `console/src/components`; brand tokens from the landing page                         | The owner chose the landing page look.                                      |
| Members sign in with email, sessions and TOTP                           | Wallet message sign in; email and TOTP after testnet                                                       | 2.6.                                                                        |
| UJIRA held agent keys in a KMS signer service                           | Per project keys encrypted with a key encryption key from the environment on testnet; a KMS before mainnet | Speed; the KMS port is a mainnet item.                                      |
| Anchor rails at launch                                                  | Out; a partner rail later                                                                                  | Owner decision.                                                             |

Unchanged: Postgres (Supabase is the named production host, subject to the owner's approval), Graphile Worker, Hono, versioned REST with OpenAPI, the mandate spec and the deployed contracts, the chain adapter boundary, and every data rule in section 8.

## 5. What is ported, adapted or dropped

"As is" means the code is copied with import paths and the licence header changed and its tests come with it. "Adapted" means the shape is kept and the code is cut down or rewired.

| Monorepo source                                                                                                                                                                                                                            | Disposition                                                                                                                   | Target here                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/db` foundation: `config`, `connection-url`, `tls` (pinned Supabase CA), `database`, `tenant`, `session-state`, `errors`, `migrate`, `money-mapper`, `unavailable`, `testing/`                                                    | As is                                                                                                                         | `src/db/`                                 |
| Migrations: amount domain and reference data, roles and tenant context, principals, projects and API tokens, token lineage, format, expiry and rate limit buckets, idempotency keys, audit log and action catalog, outbox, security events | As is, renumbered from `1800000000000` so the order is ours                                                                   | `db/migrations/`                          |
| Migrations for mandates, recipients, payout methods, payouts, legs, approvals, receipts                                                                                                                                                    | Adapted: same column names and composite tenant keys, without attempts, fee terms, instance lifecycle and funding accounts    | `db/migrations/`                          |
| Migrations for funding accounts and sweeps, compliance, managed signers, fee estimates and fallback, identity evidence, attestation, chain cursors, mandate flags                                                                          | Dropped for now; ported additively when their feature is                                                                      | none                                      |
| Repositories: tenancy, idempotency, audit, outbox, page, retention                                                                                                                                                                         | As is                                                                                                                         | `src/db/repositories/`                    |
| Repositories: mandates, recipients, payouts, payout legs, payout views, receipts                                                                                                                                                           | Adapted to the new domain tables                                                                                              | `src/db/repositories/`                    |
| `packages/core` money (`money`, `allocate`, `parse`, `format`, `currencies`, `errors`)                                                                                                                                                     | As is                                                                                                                         | `src/money/`                              |
| `packages/api`: `app`, `route`, `errors`, `body`, `log`, `openapi`, `cursor`, `auth`, `token`, `token-auth`, `api-key-service`, `rate-limit`, `client-address`, `idempotency`, `embed-auth`, `embed-token`                                 | As is or nearly                                                                                                               | `src/api/`, `src/auth/`                   |
| `packages/api`: payout, mandate, recipient and signing services and routes                                                                                                                                                                 | Adapted to the engine and the adapter here                                                                                    | `src/api/routes/`, `src/payouts/`         |
| `packages/api-schema`: `money`, `common`, `envelope`, `enums`, `payouts`, `receipts`, `recipients`, `mandates`, `errors`                                                                                                                   | Adapted: only the token amount and wallet rail shapes, same field names                                                       | `src/api/schema/`, shared with `console/` |
| `packages/chain-adapter`: `types` (interface), `stellar/sep53`, `wallet-proof`, `stellar/check-destination`, `receipt-ref`, `codecs/envelope`, `retry`, `errors`                                                                           | Adapted into the interface in 7.1                                                                                             | `src/chain/`                              |
| `packages/chain-adapter` funding accounts, sweeps, rent, TTL, forwarder, executor channels, XLM rates                                                                                                                                      | Dropped for testnet; channel accounts and sponsored reserves return as mainnet items                                          | none                                      |
| `packages/receipts`: `model`, `canonical`, `document`, `views`, `export`, `verify`                                                                                                                                                         | Adapted to the wallet rail; receipt signing comes later                                                                       | `src/receipts/`                           |
| `packages/identity`: `wallet-proof/*`, `destination`, `timeout`, `errors`                                                                                                                                                                  | Adapted                                                                                                                       | `src/identity/`                           |
| `packages/identity`: `self/*`                                                                                                                                                                                                              | Later (P1), behind a flag, once a Self account exists                                                                         | `src/identity/self/`                      |
| `packages/embed` (Lit widget, i18n, theme)                                                                                                                                                                                                 | Adapted to the wallet method only                                                                                             | `embed/`                                  |
| `packages/payouts` worker stack (open pull requests)                                                                                                                                                                                       | Not ported as code. Its ideas are: tenant safe job payloads, one queue per signing key, a dead letter path, a reconcile sweep | `src/worker/`, `src/payouts/`             |
| `packages/router`                                                                                                                                                                                                                          | Adapted to a config table of rails per network, one rail enabled                                                              | `src/payouts/rails.ts`                    |
| `packages/signer` (AWS KMS)                                                                                                                                                                                                                | Mainnet item                                                                                                                  | `src/keys/` later                         |
| `packages/funding`, `packages/indexer`, `packages/mandates` policy rules                                                                                                                                                                   | Dropped for testnet. Deposits are read from the mandate's balance on chain.                                                   | none                                      |
| `packages/mcp`                                                                                                                                                                                                                             | Dropped; the MCP server here is the base                                                                                      | `src/mcp/`                                |
| `apps/dashboard`, `packages/ui`                                                                                                                                                                                                            | Not ported as code; screen designs and table patterns (filters in the URL, CSV export) are reused in the console              | `console/`                                |

Licence: the monorepo code carries a proprietary header and this repository is public under Apache 2.0. Ported files take the Apache 2.0 header here. That is a licensing change for Qomira Labs' own code, so the owner confirms it before the first port merges.

## 6. Module layout

One npm package for the server, plus the console and the embed widget as their own Vite builds, as the console is today. Every arrow below is an allowed import; anything else is refused by the lint rules in 8.3.

```
src/
  server/      entry point; composes web, api, mcp and worker by UJIRA_ROLES
  config/      env parsing with zod, one schema per role
  money/       bigint minor units, allocation, parsing and formatting
  db/          the only code that imports pg or kysely; tenant transactions; repositories
  chain/       the ChainAdapter interface and its Stellar implementation; the only code that imports @stellar/stellar-sdk
  keys/        agent key storage and signers (decrypt in memory only)
  auth/        wallet sign in, sessions, API keys, scopes, rate limits
  tenancy/     principals, projects, members
  payouts/     payout service, status machine, legs, rails (wallet rail, partner rail slot)
  receipts/    issue, read, export, verify
  identity/    recipient wallet proof; Self later
  worker/      Graphile Worker runner, task list, cron schedule
  api/         Hono app for /v1, schemas, OpenAPI, error envelope, idempotency
  mcp/         MCP over stdio and HTTP; tools call the payouts and receipts services
  demo/        faucet, test recipients, recycler, the public demo mandate, the SDP rail; testnet only
  web/         static site, console and embed files
console/       Vite and React dashboard
embed/         Lit widget, built to /embed/v1/ujira-embed.js
db/migrations/ node-pg-migrate SQL files
```

`api`, `mcp` and `worker` call `payouts`, `receipts`, `tenancy`, `auth` and `identity`. Those call `db` and `chain`. `money` is imported by anything. Nothing outside `chain` branches on the network or imports a Stellar library; nothing outside `db` touches SQL.

## 7. Interfaces

### 7.1 Chain adapter

Kept to what the testnet product calls. It reuses the monorepo's names so that the full interface can return additively.

```ts
export const CHAIN_ADAPTER_VERSION = 1;
export type NetworkId = 'stellar:testnet' | 'stellar:pubnet';
export type Hex32 = string; // 64 lower case hex digits

export interface CallOptions {
  readonly signal: AbortSignal; // every call is bounded; default 10 s
  readonly correlationId: string; // the payout or request id, for logs
}

export interface SigningRequest {
  readonly network: NetworkId;
  readonly xdr: string; // unsigned transaction envelope, base64
  readonly signer: string; // the account that must sign
  readonly action: MandateAction['kind'];
  readonly summary: string; // what the wallet is about to sign, in words
  readonly expiresAt: string; // ISO 8601
}

export type MandateAction =
  | {
      kind: 'create';
      principal: string;
      agent: string;
      executor: string;
      approvers: readonly string[];
      approvalsRequired: number;
      limits: Limits;
      recipients: readonly AllowEntry[];
    }
  | { kind: 'fund'; from: string; amount: bigint }
  | { kind: 'allow_recipients'; entries: readonly AllowEntry[] }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'revoke' }
  | { kind: 'approve'; approver: string; payoutId: Hex32 }
  | { kind: 'reject'; approver: string; payoutId: Hex32 }
  | { kind: 'withdraw'; amount: bigint };

export interface PayoutIntent {
  readonly mandate: string; // contract address
  readonly payoutId: Hex32; // sha256 over the mandate and the task id, as the engine derives it today
  readonly taskRef: Hex32;
  readonly recipientRef: Hex32;
  readonly legs: readonly { readonly destination: string; readonly amount: bigint }[];
  readonly fee: bigint; // 0 on testnet
  readonly deadline: bigint; // unix seconds
}

export type ChainPayoutState =
  | { kind: 'absent' }
  | { kind: 'pending'; approvals: number }
  | { kind: 'approved' }
  | { kind: 'executed' }
  | { kind: 'rejected' }
  | { kind: 'cancelled' };

export type CheckResult = { ok: true } | { ok: false; specError: string }; // e.g. DAILY_CAP_EXCEEDED

export interface ChainAdapter {
  readonly version: typeof CHAIN_ADAPTER_VERSION;
  readonly network: NetworkId;
  health(o: CallOptions): Promise<{ ok: boolean; latestLedger: number }>;
  parseAccount(raw: string): string;
  readMandate(
    contract: string,
    o: CallOptions,
  ): Promise<{ config: MandateConfigView; state: MandateStateView }>;
  prepareMandateAction(
    contract: string | null,
    action: MandateAction,
    o: CallOptions,
  ): Promise<SigningRequest>;
  submitSigned(
    signedXdr: string,
    expected: SigningRequest,
    o: CallOptions,
  ): Promise<{ txHash: string }>;
  sponsorFee(signedXdr: string, principal: string, o: CallOptions): Promise<string>; // fee bump envelope
  checkPayout(intent: PayoutIntent, agent: string, o: CallOptions): Promise<CheckResult>; // simulation only
  requestPayout(intent: PayoutIntent, agent: TxSigner, o: CallOptions): Promise<{ txHash: string }>;
  executePayout(
    contract: string,
    payoutId: Hex32,
    executor: TxSigner,
    o: CallOptions,
  ): Promise<{ txHash: string }>;
  payoutState(contract: string, payoutId: Hex32, o: CallOptions): Promise<ChainPayoutState>;
  transaction(
    txHash: string,
    o: CallOptions,
  ): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number }>;
  checkDestination(
    account: string,
    asset: string,
    o: CallOptions,
  ): Promise<
    | { receivable: true }
    | { receivable: false; reason: 'NO_ACCOUNT' | 'NO_TRUSTLINE' | 'NEEDS_MEMO' }
  >;
  walletProofMessage(p: {
    purpose: 'sign_in' | 'recipient_wallet';
    address: string;
    origin: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
  }): string;
  verifyWalletProof(address: string, message: string, signatureBase64: string): boolean; // SEP-53
  receiptRef(txHash: string, eventIndex: number): string; // ujira:tx:v1:stellar:testnet:<hash>:<index>
}
```

`Limits`, `MandateConfigView`, `MandateStateView`, `AllowEntry` and `TxSigner` are the types the engine already has. Errors are one class, `ChainError`, with `code` in `TIMEOUT`, `UNAVAILABLE`, `INVALID_ADDRESS`, `CONTRACT_REFUSED` (with `specError`), `TX_FAILED`, `SIGNATURE_INVALID`, `SIGNING_REQUEST_MISMATCH`. `submitSigned` refuses any envelope whose operations, source, contract or arguments differ from the `SigningRequest` it was built from (the console's transaction allowlist moves here).

### 7.2 Rails

The existing `PayoutRail` stays. Its names become rail ids: `stellar.wallet` (today `usdc`) is the only product rail; `demo.sdp` lives in `src/demo`. A partner rail implements the same interface with `kind: 'partner'` and is enabled per network in the `rails` config table. Rail choice is config: the recipient's verified methods, filtered by the rails enabled for the network. No enabled rail for a recipient means the payout is `blocked` with `RECIPIENT_HAS_NO_METHOD`.

### 7.3 Payout states and legs

Wire status names are the monorepo's, so a later port adds states without renaming any.

| From               | To                                                           |
| ------------------ | ------------------------------------------------------------ |
| `queued`           | `submitting`, `blocked`, `failed`                            |
| `submitting`       | `pending_approval`, `approved`, `blocked`, `needs_attention` |
| `pending_approval` | `approved`, `rejected`, `cancelled`                          |
| `approved`         | `settling`                                                   |
| `settling`         | `paid`, `needs_attention`                                    |
| `needs_attention`  | `submitting`, `settling`, `paid`, `failed`                   |

Terminal: `paid`, `blocked`, `rejected`, `cancelled`, `failed`. `partly_paid` is reserved for split payouts. The table is data (`ujira.status_transitions`) and a trigger refuses any other update. A payout has one or more legs from day one; a wallet payout has one. Leg amounts sum exactly to the payout total, with any remainder on the first leg. Mandate checks run on the total.

### 7.4 Public API `/v1`

Authentication: `Authorization: Bearer ujk_test_...` (the ported token format, scoped to one project) or the `ujira_session` cookie plus `Ujira-Project: <uuid>`. Session writes also need the `Origin` to be the app origin. Every response carries `Ujira-Request-Id`. Bodies are JSON, at most 64 KB, validated by strict zod schemas.

Amounts on the wire are token amounts, the ported shape:

```json
{ "amount": "25000000", "asset": "USDC", "network": "stellar:testnet", "scale": 7 }
```

| Route                                                                                                      | Auth                                                        | Notes                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/challenge`                                                                                  | none                                                        | `{ address }` to `{ challengeId, message, expiresAt }`; 10 minute single use challenge                             |
| `POST /v1/auth/session`                                                                                    | none                                                        | `{ challengeId, address, signature }`; sets the cookie; returns the member and their principals                    |
| `DELETE /v1/auth/session`, `GET /v1/me`                                                                    | session                                                     |                                                                                                                    |
| `POST /v1/principals`, `GET /v1/projects`, `POST /v1/projects`                                             | session                                                     | creating a principal creates its first project and makes the caller owner                                          |
| `POST /v1/api-keys`, `GET /v1/api-keys`, `DELETE /v1/api-keys/{id}`                                        | session, owner or admin                                     | the secret is returned once                                                                                        |
| `POST /v1/mandates/prepare`                                                                                | session                                                     | builds the factory call naming the project's agent key and the UJIRA executor; returns a `SigningRequest`          |
| `POST /v1/mandates/import`                                                                                 | session                                                     | `{ contractId }`; accepted only if the chain names the member's wallet as principal and the project's key as agent |
| `GET /v1/mandates`, `GET /v1/mandates/{id}`                                                                | both, `mandates:read`                                       | chain config and state, balance, committed, deposit address                                                        |
| `POST /v1/mandates/{id}/actions`                                                                           | session                                                     | `MandateAction` to `SigningRequest`                                                                                |
| `POST /v1/signing/submit`                                                                                  | session                                                     | `{ signingRequestId, xdr }`; fee bumped, relayed, recorded                                                         |
| `POST /v1/recipients`, `GET /v1/recipients`, `GET /v1/recipients/{id}`                                     | both, `recipients:*`                                        | label, optional Stellar address; adding one returns an `allow_recipients` signing request                          |
| `POST /v1/payouts/quote`                                                                                   | key, `payouts:read`                                         | `{ allowed, approval_required, blocked }` with the spec error name                                                 |
| `POST /v1/payouts`                                                                                         | key or session, `payouts:write`, `Idempotency-Key` required | 202 with the payout                                                                                                |
| `GET /v1/payouts`, `GET /v1/payouts/{id}`                                                                  | both, `payouts:read`                                        | cursor pages, filters `status`, `mandateId`, `recipientId`, `createdFrom`, `createdTo`                             |
| `GET /v1/approvals`                                                                                        | session                                                     | payouts in `pending_approval`; approving is a wallet signed mandate action                                         |
| `GET /v1/receipts`, `GET /v1/receipts/{id}`, `GET /v1/receipts/export.csv`, `GET /v1/receipts/{id}/verify` | both, `payouts:read`                                        |                                                                                                                    |
| `POST /v1/embed/sessions`                                                                                  | key, `recipients:write`                                     | short lived recipient token for the widget                                                                         |
| `GET /v1/stats/overview`                                                                                   | session                                                     | paid this period, counts by status, approvals waiting                                                              |
| `GET /v1/openapi.json`, `GET /healthz`                                                                     | none                                                        |                                                                                                                    |

Create a payout:

```json
POST /v1/payouts
Idempotency-Key: 7c1d0b2e-run-42
{
  "mandateId": "0b8f...uuid",
  "recipientId": "5a1e...uuid",
  "amount": { "amount": "25000000", "asset": "USDC", "network": "stellar:testnet", "scale": 7 },
  "taskId": "task-42",
  "metadata": { "batch": "week-48" }
}
```

The response is `202` with `{ "payout": PayoutDetail }`. `PayoutDetail` has `id`, `principalId`, `projectId`, `mandate { id, contractId }`, `recipient { id, label }`, `taskId`, `amount`, `fee`, `status`, `blockedBy` (spec error name or null), `legs [{ index, method, destination (masked), amount, status, txHash }]`, `onChainPayoutId`, `requestTxHash`, `receiptId`, `createdAt`, `updatedAt`, `settledAt`. Metadata holds at most 16 keys of 256 characters and is never shown to recipients.

Errors share one envelope: `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.

| Code                                                  | Status   | When                                                          |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `INVALID_REQUEST`                                     | 400      | schema failure; `details` names paths, never values           |
| `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`         | 413, 415 |                                                               |
| `TOKEN_MALFORMED`, `TOKEN_INVALID`, `SESSION_INVALID` | 401      |                                                               |
| `TOKEN_ENVIRONMENT_MISMATCH`                          | 401      | a `ujk_live_` key on testnet, or a `ujk_test_` key on mainnet |
| `FORBIDDEN`, `ORIGIN_NOT_ALLOWED`                     | 403      | missing scope or role, cross site write                       |
| `NOT_FOUND`                                           | 404      | also for rows of another tenant                               |
| `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` | 400      |                                                               |
| `IDEMPOTENCY_KEY_REUSED`                              | 422      | same key, different body                                      |
| `IDEMPOTENCY_IN_PROGRESS`                             | 409      | same key while the first request runs                         |
| `TASK_ID_REUSED`                                      | 409      | same task on the same mandate under another key               |
| `API_KEY_LIMIT_REACHED`                               | 409      | the project already holds 20 active keys                      |
| `RECIPIENT_LABEL_TAKEN`                               | 409      | a recipient on the mandate has that label, any case           |
| `MANDATE_REFUSED`                                     | 409      | the mandate refuses the change; `details` names why           |
| `MANDATE_PRINCIPAL_MISMATCH`                          | 403      | import: the chain names another wallet as principal           |
| `AGENT_KEY_MISSING`                                   | 409      | the project has no agent key on this network yet              |
| `MANDATE_TAKEN`                                       | 409      | the contract is attached to another project                   |
| `SIGNING_REQUEST_USED`                                | 409      | the chain already took a transaction for it                   |
| `SIGNING_REQUEST_EXPIRED`                             | 410      | the signing window closed; prepare it again                   |
| `MANDATE_AGENT_MISMATCH`                              | 422      | import: not this project's agent and UJIRA executor           |
| `RECIPIENT_MODE_UNSUPPORTED`                          | 422      | attested only recipients, refused at prepare                  |
| `SIGNING_REQUEST_MISMATCH`, `SIGNATURE_INVALID`       | 422      | the signed envelope is not the one prepared                   |
| `CONTRACT_REFUSED`, `TX_FAILED`                       | 422      | the chain refused it; `details` names the spec error          |
| `RATE_LIMITED`                                        | 429      | with `Retry-After`                                            |
| `CHAIN_UNAVAILABLE`, `DB_UNAVAILABLE`                 | 503      |                                                               |
| `INTERNAL`                                            | 500      |                                                               |

A payout the mandate refuses is not an error: it is created with status `blocked` and the spec error name, so the caller has a record and a receipt of the refusal.

Versioning: `/v1` only grows. New fields are optional, new enum values are announced in the changelog first, and clients must ignore unknown fields. A breaking change is `/v2`, run beside `/v1`.

### 7.5 MCP

`POST /v1/mcp` takes a project API key and serves `quote_payout`, `request_payout`, `payout_status` and `list_receipts`, which call the same services as `/v1`, so the rules and the idempotency are the same. The task id is the idempotency key for `request_payout`. The public demo at `/mcp` and `/m/<mandate>/mcp` keeps working for existing connectors and moves to `src/demo`.

### 7.6 Worker jobs

| Task                | Queue                | What it does                                                                                             |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `payout.advance`    | `agent:<project id>` | reads the chain first, then requests the payout or records approval, rejection, block or lapse           |
| `payout.execute`    | `executor`           | executes an approved payout, records the leg transaction, moves to `paid`                                |
| `receipt.issue`     | none                 | writes the receipt of a terminal payout once                                                             |
| `payouts.reconcile` | cron every 2 minutes | finds payouts stuck past their deadline, compares with the chain, fixes drift or marks `needs_attention` |
| `maintenance.prune` | cron daily           | expired challenges, sessions, idempotency keys and refilled rate limit buckets                           |

Every job payload is `{ principalId, projectId, payoutId }` and runs inside a tenant transaction. Job keys are `payout:<id>:<task>`, so a duplicate enqueue collapses. A Graphile queue runs one job at a time, which keeps one signing key from racing its own sequence number. Jobs retry with backoff up to 10 attempts; the last failure moves the payout to `needs_attention` and logs `event=payout_dead_letter`.

### 7.7 Config keys (new)

| Key                                                                                                                                                      | Meaning                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UJIRA_ROLES`                                                                                                                                            | `web`, `worker` or `web,worker`                                    |
| `UJIRA_DB_APP_URL`                                                                                                                                       | app login through the transaction pooler                           |
| `UJIRA_DB_WORKER_URL`                                                                                                                                    | worker login through the session pooler (LISTEN needs it)          |
| `UJIRA_DB_MIGRATOR_URL`                                                                                                                                  | migrator login through the session pooler                          |
| `UJIRA_DB_POOL_SIZE`                                                                                                                                     | per process, default 5                                             |
| `UJIRA_STORE`                                                                                                                                            | `file` or `postgres`, for the cutover only                         |
| `UJIRA_KEY_ENCRYPTION_KEY`                                                                                                                               | 32 bytes, base64; encrypts agent keys and personal data            |
| `UJIRA_EXECUTOR_SECRET`                                                                                                                                  | existing; the shared executor                                      |
| `UJIRA_FEE_SPONSOR_SECRET`, `UJIRA_FEE_SPONSOR_DAILY_CAP`                                                                                                | fee bump account and its per principal daily cap in stroops        |
| `UJIRA_DEMO_FEATURES`                                                                                                                                    | `on` enables `src/demo`; refused unless `UJIRA_NETWORK=testnet`    |
| `UJIRA_WORKER_CONCURRENCY`                                                                                                                               | default 4                                                          |
| `UJIRA_BACKUP_S3_ENDPOINT`, `UJIRA_BACKUP_S3_BUCKET`, `UJIRA_BACKUP_S3_ACCESS_KEY_ID`, `UJIRA_BACKUP_S3_SECRET_ACCESS_KEY`, `UJIRA_BACKUP_AGE_RECIPIENT` | off site backup target and the public key backups are encrypted to |

## 8. Data rules and how they are enforced

### 8.1 Money is integer minor units

- Database: every amount column uses the ported `ujira.amount` domain (numeric, scale 0, inside i128) next to its asset and scale, with foreign keys to the reference tables of assets and scales.
- Code: `bigint` only. The ported money mapper turns `numeric` into `bigint` on read. Lint refuses `parseFloat`, `Number(` and `Math.round` in `src/money`, `src/payouts`, `src/receipts`, `src/api` and `src/db`.
- Wire: decimal strings of minor units with explicit `asset`, `network` and `scale`. Display formatting happens only in the console and the receipt views, from one formatter.
- Tests: property tests for parsing, formatting and leg allocation (the sum always equals the total).

### 8.2 Idempotency is a unique constraint

| Layer    | Constraint                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP     | `idempotency_keys` unique on `(principal_id, project_id, idempotency_key)` with the request hash; a replay returns the stored response, a different body is `IDEMPOTENCY_KEY_REUSED` |
| Business | `payouts` unique on `(principal_id, project_id, mandate_id, task_id)`                                                                                                                |
| Chain    | `payouts` unique on `(mandate_id, onchain_payout_id)`; the payout id is derived from the mandate and the task, and the contract refuses an id twice                                  |
| Legs     | `payout_legs` unique on `(payout_id, leg_index)` and on `leg_key`, derived from the payout key                                                                                       |
| Receipts | `receipts` unique on `payout_id`                                                                                                                                                     |
| Jobs     | Graphile job keys; every handler reads chain state before acting                                                                                                                     |

The payout row and its first job are written in one transaction, before any chain call. No transaction is sent for a payout that is not in the database.

### 8.3 Tenant isolation

- Every tenant table has `principal_id` and `project_id`, composite foreign keys `(principal_id, project_id, id)` to its parents, and forced row level security through the ported `apply_tenant_policies`.
- The app connects as `ujira_app`, which has no `BYPASSRLS` and owns nothing. Tenant settings are transaction local and travel with `BEGIN` (the ported `tenant.ts`); a session level setting is refused.
- A catalog test fails if any table in schema `ujira` lacks the columns, the forced policies or the composite key, except an explicit list of reference tables.
- A cross tenant suite creates two principals with two projects each and asserts that every repository read returns nothing and every write is refused across them.
- API keys belong to one project. Sessions name the project in a header and are checked against membership on every request.
- Per project agent keys make the chain refuse a payout request on another project's mandate.
- Lint: `pg` and `kysely` only in `src/db`; `@stellar/stellar-sdk` only in `src/chain` and `src/demo`.

### 8.4 Keys and secrets

Agent secrets are encrypted with AES-256-GCM under `UJIRA_KEY_ENCRYPTION_KEY`, with the project id as associated data, and decrypted only inside a signer. Session tokens and API key secrets are stored as SHA-256 hashes. No secret, signature, session token or personal field is logged. The executor and fee sponsor secrets live in the host's environment only.

### 8.5 Retention

| Data                               | Kept                                                |
| ---------------------------------- | --------------------------------------------------- |
| Sign in challenges                 | 10 minutes, pruned daily                            |
| Sessions                           | 30 days idle, 90 days absolute                      |
| Idempotency keys                   | 7 days                                              |
| Payouts, legs, receipts, audit log | not deleted; append only where money moved          |
| Recipient labels and emails        | encrypted; erasure rules are settled before mainnet |
| Backups                            | 30 days                                             |

## 9. Migrating the JSON stores

1. The registry and the receipt log move behind two ports, `RegistryStore` and `ReceiptStore`, with the file implementation that exists today and a Postgres one. `UJIRA_STORE` picks one.
2. `scripts/import-file-stores.ts` reads `console-registry.json`, `receipts.json` and `test-wallets.json`. Each principal wallet in the registry becomes a principal with a default project and that wallet as owner, so the person sees their mandates after signing in. Mandates, recipients and receipts follow under that tenant. Receipts of the public demo mandate go to a "UJIRA public demo" principal. Test wallet secrets go to the demo schema, encrypted. Faucet claims go to the demo schema.
3. The import is idempotent (upserts on natural keys), has `--dry-run`, and prints counts per table, which must match the counts read from the files.
4. Cutover: deploy with Postgres reachable and `UJIRA_STORE=file`, run the import, compare counts, set `UJIRA_STORE=postgres`. The files stay read only on the volume for 30 days, then are deleted.
5. Mandates created through the old console name the shared agent key. They keep working through it until their principal creates a new mandate, which names the project key. The shared key is retired when no imported mandate is active.

## 10. Failure modes

| Failure                                             | Behaviour                                                                                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC timeout or outage                               | Every chain call has a 10 s bound. Jobs retry with backoff; payouts stay `queued` or `submitting`; `/healthz` reports the chain degraded; `/v1` still accepts payouts (202).                                                            |
| Process restart mid payout                          | Graphile releases the job; the retry reads the chain first. A request that landed is not requested again, an execution that landed is recorded, never repeated.                                                                         |
| Request landed, execute failed                      | The engine's existing partial settlement path: the payout stays `settling` and the next attempt resumes from the chain.                                                                                                                 |
| Duplicate client retry                              | HTTP replay from `idempotency_keys`; the business key and the chain refuse a second payout.                                                                                                                                             |
| Two workers on one key                              | One Graphile queue per agent key and one for the executor.                                                                                                                                                                              |
| Database down                                       | `/v1` answers 503 `DB_UNAVAILABLE`; the worker stops taking jobs; nothing is sent on chain without a row.                                                                                                                               |
| Overload                                            | Per key and per address token buckets in Postgres (ported); 429 with `Retry-After`; bounded worker concurrency; pool exhaustion answers 503.                                                                                            |
| Bad input                                           | Strict schemas, 64 KB bodies, account and contract addresses parsed by the adapter, metadata bounded.                                                                                                                                   |
| Mandate paused, revoked, expired or out of budget   | The quote and the contract say so; the payout is `blocked` with the spec error name and a receipt.                                                                                                                                      |
| Approval never arrives                              | The mandate's payout TTL lapses it, which releases its committed funds; reconcile cancels the lapsed payout with the executor, which the contract allows for a lapsed payout, and moves it to `cancelled`. The agent key never cancels. |
| Recipient cannot receive (no account, no trustline) | The destination check blocks before the request; reconcile marks `needs_attention` if it changes later.                                                                                                                                 |
| No rail for the recipient                           | `blocked` with `RECIPIENT_HAS_NO_METHOD`. With one rail there is no fallback; a partner rail later becomes the second.                                                                                                                  |
| Executor or fee sponsor low on XLM                  | Alert log line below a threshold; jobs fail and retry rather than skip.                                                                                                                                                                 |
| A partner rail down                                 | Not in this build; the rail interface reports health so routing can skip it.                                                                                                                                                            |

## 11. Test strategy

- Unit tests with vitest for every module, with the existing fake RPC for the engine and the adapter.
- Database tests on a real Postgres through testcontainers (the ported harness): migrations up and down from empty, the catalog test, the cross tenant suite, transition triggers, every unique constraint.
- Property tests (fast-check) for money and leg allocation.
- Worker tests with a real Graphile Worker against the test database: restart mid job, duplicate enqueue, dead letter.
- API tests against the generated OpenAPI: every route, every error code, idempotency replays, concurrent identical requests.
- Console tests with Testing Library; Playwright flows in CI only.
- A testnet end to end run (sign in, key, mandate, payout, receipt) nightly in CI once its secrets exist, and before each release.
- Coverage holds at least 85 percent overall and 95 percent for money, payouts, auth and keys.

## 12. Rollout and rollback

- Week 1: persistence foundation, adapter interface, `/v1` scaffold, sign in library, widget port, run roles. Nothing user visible changes.
- Week 2: sign in, projects, keys, mandates and payouts on Postgres behind `UJIRA_STORE`; import rehearsed on a copy.
- Week 3: worker, receipts, dashboard on `/v1`, embed, backups, cutover on testnet.
- Week 4: restore drill, security review of auth, tenancy, keys and signing, fixes, launch.
- Each migration is expand and contract with a down migration. Rollback is a redeploy of the previous image; before the cutover, `UJIRA_STORE=file` returns to the files. After product writes begin, rollback of data is a restore.

## 13. Evidence

| Claim                                                                                                                                                 | Kind                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| This repository serves the site, `/app`, `/api` and `/mcp` at ujira.co and its console end to end run passed on testnet (`evidence/console-e2e.json`) | measured                                                                                                                    |
| The engine has paid testnet payouts with blocks and approvals through the deployed mandate (`evidence/testnet-run.json`)                              | measured                                                                                                                    |
| The monorepo has 71 migrations, 120 database source files and 104 database test files on its development branch                                       | measured (counted)                                                                                                          |
| A session level setting leaks to another client through the Supabase transaction pooler, so tenant settings must be transaction local                 | measured, monorepo Supabase spike                                                                                           |
| LISTEN is not delivered through the transaction pooler and is through the session pooler                                                              | measured, same spike                                                                                                        |
| The tenant context costs one round trip when sent with BEGIN, so the database must sit in the same region as the app                                  | measured, same spike                                                                                                        |
| The Supabase direct host is IPv6 only; the shared pooler resolves over IPv4                                                                           | measured (DNS), same spike                                                                                                  |
| Railway reaches the Supabase poolers over IPv4                                                                                                        | assumed; spike issue in the infra track                                                                                     |
| Freighter and Albedo produce SEP-53 signatures our verifier accepts                                                                                   | assumed; spike issue in the auth track                                                                                      |
| One executor key serialised in one queue gives about ten payouts a minute                                                                             | assumed (one transaction per ledger of about five seconds, plus waits); enough for testnet, channel accounts before mainnet |
| Graphile Worker job keys collapse duplicate jobs, and named queues run one job at a time                                                              | referenced, Graphile Worker documentation                                                                                   |

## 14. Why the rejected options lost

- Finishing the monorepo (2.1 B) loses on time: its critical pieces are large unmerged stacks for features outside this window, and it has never been deployed.
- A third repository (2.1 C) costs both migrations at once.
- JSON files (2.2 A) cannot carry unique constraints, tenant policies or backups.
- Porting all migrations (2.2 B) imports invariants that need the monorepo worker, indexer and fee stack.
- Next.js (2.3 B) adds a runtime and a look the owner rejected.
- A hand written `/v1` (2.4 B) rewrites middleware we already have.
- Render now (2.5 B) is a migration with no gain before launch.
- Email and TOTP (2.6 B) and passkeys (2.6 C) are larger than wallet sign in and not needed to launch on testnet.
- A shared agent key (2.7 A) leaves isolation to application code alone.
- A separate worker service now (2.8 B) costs money before load needs it.

## 15. Consequences and reversibility

- The public repository now holds the product. Secrets never enter it; the CI secret scan covers the full history.
- The monorepo pull requests stop. Each is ported into an issue here, closed as superseded, or kept for later, case by case.
- `@ujira/mcp` on npm is not published again from this package until it is a thin client of `/v1`; today's package keeps working.
- Reversible: hosting (one Dockerfile), the dashboard (an API client), the worker placement (a role flag), sign in methods (additive). Hard to reverse: the database schema and the tenancy model, which is why they are ported rather than invented.

## 16. Confidence and what makes us revisit

Confidence: medium high on the base and the persistence design, medium on the timeline.

Revisit when:

- the Railway to Supabase spike fails or the tenant transaction round trip from Railway exceeds 20 ms p50: move the database or the app so they share a region;
- either wallet cannot sign SEP-53 messages: add email sign in earlier;
- payout throughput needs more than one executor transaction per ledger: bring channel accounts forward;
- a partner rail arrives: extend 7.2 and the receipts, additively;
- the owner does not approve the licence change for ported code: keep the ported modules in a private repository and consume them as a package.

## 17. Amendment, 2026-11-27: the database host is Render Postgres

The engineer chose Render Postgres for the product database in place of Supabase, and the CEO approved the spend. One `basic_256mb` instance in Render's Virginia region, the same metro as the Railway service, with Render's PgBouncer in transaction mode on port 6432. What changes:

- The app connects through PgBouncer on 6432; the worker and the migrator connect directly on 5432. Section 7.7's "transaction pooler" and "session pooler" read as PgBouncer and the direct connection.
- TLS is pinned to the Let's Encrypt roots Render's certificates chain to, instead of the Supabase CA.
- Render keeps 3 to 7 days of point in time recovery. The 30 days in 8.5 come from the off site backup job.
- The revisit signal in section 16 now reads "the Railway to Render spike".

The measurements and the open items are in `docs/spikes/render-postgres.md`.
