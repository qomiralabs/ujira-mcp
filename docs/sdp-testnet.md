# Running the Stellar Disbursement Platform on testnet

The `sdp` rail pays through the Stellar Disbursement Platform (SDP). There is
no public hosted SDP on testnet that we may use, so we run the upstream SDP
backend locally in Docker against the public Stellar testnet. No money is
spent: every account is funded by friendbot and the USDC is Circle's testnet
USDC.

## How a payout flows

1. The agent requests a payout on the mandate. The leg destination is the SDP
   distribution account, and the recipient reference is the person's.
2. Once the mandate approves (and an approver signs, above the threshold), the
   executor runs `execute`, which moves the USDC from the mandate to the SDP
   distribution account. This is the first transaction hash.
3. The rail creates one SDP disbursement for the payout, named
   `ujira-<payout id>`, with the person's wallet, the amount and the task ID as
   the SDP payment ID. It does this before step 2, so nothing moves if SDP is
   down.
4. The rail starts the disbursement. SDP pays the wallet from the distribution
   account. This is the second transaction hash.
5. The receipt keeps both hashes, the SDP disbursement and payment IDs, and
   the task ID.

The mandate's allowlist holds pairs of recipient reference and destination, so
the principal allows `(person, SDP distribution account)` for each person who
may be paid through SDP. The rail only pays wallets listed in its own
configuration, by handle, so a request cannot point SDP at another wallet.

## What runs

Only three containers from the upstream `dev/docker-compose.yml`, in single
tenant mode:

| Service   | Image                                                 | Purpose                 |
| --------- | ----------------------------------------------------- | ----------------------- |
| `db`      | `postgres:14-alpine`                                  | SDP database            |
| `sdp-api` | `stellar/stellar-disbursement-platform-backend:7.1.0` | API on `localhost:8000` |
| `sdp-tss` | `stellar/stellar-disbursement-platform-backend:7.1.0` | Transaction submission  |

The dashboard, Kafka, the anchor platform and the demo wallet are not needed:
recipients already hold a Stellar wallet, so disbursements use the
`EMAIL_AND_WALLET_ADDRESS` contact type and skip SEP-24 registration. Together
the three use about 300 MB of memory.

## Setup

Prerequisites: Docker, the `stellar` CLI, `curl`, `openssl` and `python3`.

### 1. Get the compose files

```sh
mkdir -p ~/sdp && cd ~/sdp
git clone --depth 1 https://github.com/stellar/stellar-disbursement-platform-backend.git sdp-backend
```

### 2. Generate testnet keys

Keys live outside every repository, in `~/.config/ujira-testnet/sdp/`.

```sh
umask 077
C=~/.config/ujira-testnet/sdp
mkdir -p "$C"
for k in sdp-distribution sdp-sep10 sdp-encryption; do
  stellar keys generate --config-dir "$C" "$k" --network testnet -q
done
stellar keys fund --config-dir "$C" sdp-distribution --network testnet
```

- `sdp-distribution` holds the USDC that SDP pays out, and the XLM that pays
  fees and opens channel accounts.
- `sdp-sep10` signs SEP-10 challenges. It needs no funds.
- `sdp-encryption` is only used as the passphrase that encrypts channel and
  distribution keys in the SDP database.

### 3. Write the environment file

Write `~/.config/ujira-testnet/sdp/sdp.env` (mode 600) with these keys. Values
in angle brackets come from `stellar keys address` and `stellar keys secret`
for the keys above, or from `openssl rand -hex 24`.

```sh
COMPOSE_PROJECT_NAME=ujira-sdp
NETWORK_TYPE=testnet
SDP_VERSION=7.1.0
DATABASE_NAME=sdp_testnet
SINGLE_TENANT_MODE=true
BASE_URL=http://localhost:8000
SDP_UI_BASE_URL=http://localhost:3000
DISTRIBUTION_PUBLIC_KEY=<sdp-distribution address>
DISTRIBUTION_SEED=<sdp-distribution secret>
SEP10_SIGNING_PUBLIC_KEY=<sdp-sep10 address>
SEP10_SIGNING_PRIVATE_KEY=<sdp-sep10 secret>
DISTRIBUTION_ACCOUNT_ENCRYPTION_PASSPHRASE=<sdp-encryption secret>
CHANNEL_ACCOUNT_ENCRYPTION_PASSPHRASE=<sdp-encryption secret>
ADMIN_ACCOUNT=SDP-admin
ADMIN_API_KEY=<random>
SEP24_JWT_SECRET=<random>
EC256_PRIVATE_KEY="<a fresh P-256 key in PKCS8 PEM, newlines written as \n>"
DISABLE_MFA=true
DISABLE_RECAPTCHA=true
NUM_CHANNEL_ACCOUNTS=2
```

Generate the EC key with
`openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`.
Do not keep the compose file's default key or the default admin API key.

### 4. Start the three services

```sh
cd ~/sdp/sdp-backend/dev
docker compose --env-file ~/.config/ujira-testnet/sdp/sdp.env -p ujira-sdp \
  -f docker-compose.yml up -d db sdp-api sdp-tss
```

On the very first start Postgres is still initialising when the API and TSS
try to connect, and both exit. Start them again once the database is up:

```sh
docker start ujira-sdp-sdp-api-1 ujira-sdp-sdp-tss-1
curl -s http://localhost:8000/health   # "status": "pass"
```

The API runs the migrations and `setup-for-network`, which registers testnet
USDC, EURC and XLM and the "User Managed Wallet". The TSS opens its channel
accounts from the distribution account.

On Windows with Docker Desktop, if the WSL distribution has no
`/var/run/docker.sock`, run the same compose command with Docker Desktop's
`docker.exe`. Paths passed to it must be relative to the current directory,
for example `--env-file ../../../.config/ujira-testnet/sdp/sdp.env` from
`~/sdp/sdp-backend/dev`.

### 5. Create the tenant and a user

```sh
docker exec ujira-sdp-sdp-api-1 sh -c './stellar-disbursement-platform tenants ensure-default \
  --default-tenant-owner-email owner@ujira-sdp.local \
  --default-tenant-owner-first-name Ujira --default-tenant-owner-last-name Operator \
  --default-tenant-distribution-account-type DISTRIBUTION_ACCOUNT.STELLAR.ENV \
  --distribution-public-key "$DISTRIBUTION_PUBLIC_KEY" --distribution-seed "$DISTRIBUTION_SEED" \
  --distribution-account-encryption-passphrase "$DISTRIBUTION_ACCOUNT_ENCRYPTION_PASSPHRASE" \
  --channel-account-encryption-passphrase "$CHANNEL_ACCOUNT_ENCRYPTION_PASSPHRASE" \
  --disable-mfa --disable-recaptcha'
```

`DISTRIBUTION_ACCOUNT.STELLAR.ENV` makes the tenant pay from the
distribution account in the environment file, so the mandate pays one known
address. Read the tenant ID from the admin API, then add a user with a
password read from standard input (twelve characters or more):

```sh
curl -s -u "SDP-admin:$ADMIN_API_KEY" http://localhost:8003/tenants
docker exec -i ujira-sdp-sdp-api-1 ./stellar-disbursement-platform auth add-user \
  rail@ujira-sdp.local Ujira Rail --password --owner --roles owner --tenant-id <tenant id>
```

### 6. Create an API key for the rail

Log in once and create a key with read and write access. The key is shown
only once; store it as `SDP_API_KEY` in the environment file.

```sh
TOKEN=$(curl -s -X POST http://localhost:8000/login -H 'Content-Type: application/json' \
  -d '{"email":"rail@ujira-sdp.local","password":"<password>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -X POST http://localhost:8000/api-keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ujira-mcp rail","permissions":["read:all","write:all"]}'
```

### 7. Trust USDC and allow the distribution account on the mandate

The distribution account needs a USDC trustline (SDP may already have added
it; `change-trust` is harmless if so):

```sh
stellar tx new change-trust --config-dir ~/.config/ujira-testnet/sdp \
  --source-account sdp-distribution --network testnet \
  --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

The principal allows each person's recipient reference with the distribution
account as destination:

```sh
stellar contract invoke --id <mandate> --source-account principal --network testnet -- \
  allow_recipients --entries '[{"recipient_ref":"<ref>","destination":"<distribution account>"}]'
```

Every recipient wallet needs a USDC trustline too, as on the `usdc` rail.

## Configuring the rail

```ts
const rail = new SdpRail({
  client: new SdpClient({
    baseUrl: 'http://localhost:8000',
    auth: { kind: 'api_key', apiKey: process.env.SDP_API_KEY ?? '' },
  }),
  distributionAccount: 'G...',
  asset: { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  recipients: { 'recipient-1': 'G...' },
  payToDistribution: (p) => mandate.execute(executor, p.payoutId),
});
```

A dashboard user also works (`{ kind: 'password', email, password }`); the
client logs in and logs in again when the session expires. Set `tenant` on a
multi tenant SDP. Every request has a timeout (15 s by default) and the wait
for SDP to pay is bounded (180 s by default).

If the SDP leg fails after the mandate paid, the error is an `SdpRailError`
whose `progress` holds the mandate transaction hash and the SDP IDs. Call
`rail.resume(payment, mandateTxHash)` to finish it. It finds the same
disbursement by name and never starts a second payment.

## Stopping

```sh
docker compose -p ujira-sdp -f ~/sdp/sdp-backend/dev/docker-compose.yml stop
```

`down -v` also removes the database volume, which loses every tenant, user,
API key and disbursement.
