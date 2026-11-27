# Spike: the product database on Render Postgres, and the tenant transaction

- Issue: #89. Date: 2026-11-27.
- Question: can the Railway service reach a Render Postgres through the three connection paths the database module uses, and what does a tenant transaction cost?
- Answer, so far: the database is up, migrated and reachable on all three paths with verified TLS, and LISTEN is delivered on the worker's direct connection. The tenant transaction costs three round trips. It is measured only from the provisioning workstation, outside the region. The number from the Railway host, which decides the 20 ms revisit signal, is still to be measured (see "Still to do").

## The instance

| Item              | Value                                                                                                                                                                    | Kind                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Name              | `ujira-db`, in the UJIRA project, separate from the SDP database                                                                                                         | measured (API)                  |
| Region            | Render `virginia` (AWS us-east-1, Ashburn)                                                                                                                               | measured (API)                  |
| App host region   | Railway `us-east4-eqdc4a` (US East, Equinix DC4, Ashburn)                                                                                                                | measured (`railway status`)     |
| Plan              | `basic_256mb`: 256 MB RAM, under 1 CPU, 100 connections, $6 a month, plus 1 GB of storage at $0.30 per GB: **$6.30 a month**                                             | Render pricing page, 2026-11-27 |
| Postgres          | 17.12                                                                                                                                                                    | measured                        |
| `max_connections` | 103 (the plan's 100, plus Render's reserved)                                                                                                                             | measured                        |
| Pooler            | Render's integrated PgBouncer, transaction mode, port 6432, no extra cost                                                                                                | measured (API)                  |
| Backups           | point in time recovery, status `AVAILABLE` from creation: 3 days on a Hobby workspace, 7 on Pro. Logical exports on demand, kept 7 days. Stored in the database's region | measured (API) and Render docs  |
| High availability | off                                                                                                                                                                      | measured (API)                  |
| Inbound access    | IP allow list. Today it holds only the provisioning workstation's address                                                                                                | measured (API)                  |

Virginia was chosen because both hosts are in Ashburn. A TCP connect test from the Railway host was not possible (see "Still to do"), so "lowest latency to Railway" is reasoned from the two data centres, not measured.

## Connection paths

| Role      | Login                 | Path                        | Port | Why                                                                          |
| --------- | --------------------- | --------------------------- | ---- | ---------------------------------------------------------------------------- |
| app       | `ujira_app`           | PgBouncer, transaction mode | 6432 | request traffic; tenant settings are transaction local, so pooling is safe   |
| reader    | `ujira_reader`        | PgBouncer                   | 6432 | optional; reads only                                                         |
| worker    | `ujira_worker`        | direct to the server        | 5432 | LISTEN needs a session                                                       |
| migrator  | `ujira_migrator`      | direct to the server        | 5432 | the migration lock is a session advisory lock                                |
| bootstrap | Render's default user | direct to the server        | 5432 | creates the schema and the roles; migration files marked `-- bootstrap` only |

`src/db/config.ts` and the migration command line refuse 6432 (and 6543) for the worker and the migrator.

TLS: both ports present a Let's Encrypt certificate for `*.virginia-postgres.render.com`, chained leaf, YR2, Root YR cross signed by ISRG Root X1. `src/db/tls.ts` now pins ISRG Root X1 and Root YR in place of the Supabase CA, with host name verification, and the migration command line uses the same pin (it used no TLS before). Every connection in the run below verified against that pin; `pg_stat_ssl` reported TLS on the server side of every path.

## Results from the provisioning workstation

Measured with `src/db/spike-cli.ts --samples 50`, the same configuration loader and pools the services use. The workstation is far from the region, so these numbers show the shape, not the app's latency.

| Measure                                   | p50                                                        | p95       | Kind     |
| ----------------------------------------- | ---------------------------------------------------------- | --------- | -------- |
| `select 1`, app on 6432                   | 226.89 ms                                                  | 230.28 ms | measured |
| `select 1`, worker on 5432                | 217.12 ms                                                  | 254.51 ms | measured |
| `select 1`, migrator on 5432              | 212.99 ms                                                  | 235.26 ms | measured |
| Tenant transaction, app on 6432           | 651.44 ms                                                  | 825.64 ms | measured |
| Tenant transaction, worker on 5432        | 646.75 ms                                                  | 760.93 ms | measured |
| LISTEN on the worker, NOTIFY from the app | delivered in 243.17 ms                                     |           | measured |
| LISTEN through PgBouncer                  | not delivered within 3 s, as expected for transaction mode |           | measured |

The tenant transaction (`begin` with the tenant context in one statement, one read of `ujira.current_project_id()`, `commit`) is three round trips: 651 ms is three times the 217 ms `select 1`. PgBouncer added no measurable time over the direct path. From the Railway host it is therefore expected to be about three times the Railway to Virginia round trip; that is an expectation, not a measurement.

## Provisioning findings

- Render's default user is not a superuser. It has `CREATEROLE` and `CREATEDB`, and no `BYPASSRLS`.
- On Postgres 16 and later that changes two things the migrations relied on, and both were fixed in the migrations:
  - `alter role ... nobypassrls` is refused for a login without `BYPASSRLS`, even to take the attribute away. The roles migration and six later ones now alter the attribute only when a role holds it.
  - The creator of a role is made a member with ADMIN only, which counts as membership but cannot `SET ROLE`. The roles migration now checks the SET right and grants `ujira_owner` to the bootstrap login `with set true`.
- PgBouncer authenticates the roles the migrations create; no Render managed user is needed for them.
- Passwords were set as SCRAM verifiers computed on the client, so no plain password reached the server.
- All 19 migrations applied, each under its own login, and a second `up` reported nothing to do.

## Still to do

1. Measure from Railway. On the Railway host, with the variables below set, run `node dist/db/spike-cli.js --samples 200` and record the tenant transaction p50 and p95 here. If the p50 is above 20 ms, the ADR's revisit signal applies: move the database or the app so they share a region. Two things block it today: the Railway CLI needs an SSH key registered to open a shell on the service, and the allow list must admit the service's egress address.
2. Inbound access for Railway. Railway's egress addresses are not static unless static outbound IPs are enabled on the service. With them, the allow list holds exactly those addresses. Without them, the allow list has to be opened (`0.0.0.0/0`), and the database is then protected by TLS and strong per role passwords only.
3. Backups beyond Render. Render keeps 3 or 7 days of point in time recovery and keeps exports for 7 days. The 30 day retention and the off site copy come from the backup job (`UJIRA_BACKUP_S3_*`), which is not built yet, and a restore drill.

## Variables for the Railway service

Set from `~/.config/ujira-testnet/product-db/` on the operator's machine, never pasted into an issue:

- `UJIRA_DB_APP_URL` (ujira_app, port 6432)
- `UJIRA_DB_WORKER_URL` (ujira_worker, port 5432)
- `UJIRA_DB_MIGRATOR_URL` (ujira_migrator, port 5432)
- `UJIRA_DB_READER_URL` (ujira_reader, port 6432), optional
- `UJIRA_DB_BOOTSTRAP_URL`, only where the migration step runs (#90)
- `UJIRA_DB_TLS` stays unset, which means pinned.
