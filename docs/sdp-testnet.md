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

## Hosted on Render

The hosted console needs an SDP that does not depend on a laptop, so the same
three pieces also run on Render. Only one SDP may pay from the distribution
account at a time: while the Render SDP is in use, the local Docker SDP stays
stopped.

| Resource        | Render type                                         | Plan                               |
| --------------- | --------------------------------------------------- | ---------------------------------- |
| `ujira-sdp-db`  | Postgres 14                                         | Basic 256 MB, 1 GB disk            |
| `ujira-sdp-api` | Web service from the public image, pinned by digest | Starter, health check on `/health` |
| `ujira-sdp-tss` | Background worker from the same image               | Starter                            |

All three are in one region. The image is
`docker.io/stellar/stellar-disbursement-platform-backend@sha256:94cb4544c34288ecbf4fba94b2c0af9b62e8efa9bc8d463acf336c38f8a88af1`,
which is the `7.1.0` tag.

### Network

- The database has an empty IP allow list, so only services on Render's
  private network can reach it. `DATABASE_URL` is the internal connection
  string with `?sslmode=require`.
- Render sends public traffic only to `PORT` (8000). The admin API
  (`ADMIN_PORT`, 8003) and metrics (8002) listen on the private network
  only; requests to them from the internet time out.

### Start commands

Render's Docker command replaces the image entrypoint, but it keeps quotes as
literal characters, so `sh -c "a && b"` fails with `not found`. The script
therefore lives in an environment variable and the Docker command is
`sh -c eval${IFS}"$SDP_START"` (the worker uses `SDP_TSS_START`):

```sh
# sdp-api, same steps as the upstream compose file
SDP_START='./stellar-disbursement-platform db admin migrate up && ./stellar-disbursement-platform db tss migrate up && ./stellar-disbursement-platform db auth migrate up --all && ./stellar-disbursement-platform db sdp migrate up --all && ./stellar-disbursement-platform db setup-for-network --all && exec ./stellar-disbursement-platform serve'
# sdp-tss
SDP_TSS_START='./stellar-disbursement-platform channel-accounts ensure 2 && exec ./stellar-disbursement-platform tss'
```

Create the API service first and the worker after the API is live, so the
TSS tables exist when the worker starts.

### Environment

The API gets the variables from the compose file's `sdp-api` service, with
`BASE_URL`, `SDP_UI_BASE_URL` and `CORS_ALLOWED_ORIGINS` set to the service's
public URL, `SINGLE_TENANT_MODE=true`, `EMAIL_SENDER_TYPE=DRY_RUN` and
`SMS_SENDER_TYPE=DRY_RUN`. The worker gets the variables from the `sdp-tss`
service. Leave unused provider variables unset.

The distribution and SEP-10 keys are the same testnet keys as the local SDP.
Everything else is generated for Render and kept outside every repository
(mode 600): the EC256 key, the encryption passphrase (a new Stellar secret
key), the admin API key, the SEP-24 JWT secret, the user password and the
rail's API key. Do not copy the local values.

### Tenant, user and API key

Run the tenant and user setup from step 5 as a one off job on the API service
(`POST /v1/services/<id>/jobs`), so the admin API never needs to be public.
A job runs with the service's image and environment, so the password goes in
a temporary environment variable and is piped to `auth add-user` the same
way as with `docker exec -i`. SDP wants twelve characters or more with at
least one special character. `tenants ensure-default` logs the tenant ID
that `add-user` needs. Remove the temporary variables when the job has
succeeded.

Then log in through the public URL and create the rail's API key as in step 6. The rail is configured with `UJIRA_SDP_URL` (the public URL),
`UJIRA_SDP_API_KEY`, `UJIRA_SDP_DISTRIBUTION` and `UJIRA_SDP_ASSET_ISSUER`;
`UJIRA_SDP_TENANT` is not needed in single tenant mode. Waiting for SDP to
pay can take longer than the default HTTP timeout, so the hosted console sets
`UJIRA_HTTP_TIMEOUT_MS=300000`.

### Checking it

```sh
curl -s https://<sdp-api host>/health   # "status": "pass", "database": "pass"
```

A disbursement paid through the Render SDP, and the hosted console's
end to end run (`npm run console:e2e` with `UJIRA_CONSOLE_URL` set) reports
`the SDP payout is paid`. Service logs are available from Render's logs API
(`GET /v1/logs?ownerId=<workspace>&resource=<service or job id>`).
