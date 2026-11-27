-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- One row per Idempotency-Key per project, so a retried write gets its original
-- answer. The unique constraint is the guarantee: whichever instances a key's
-- retries land on, only one insert can win it.
--
-- A row is either running, holding a lease, or finished, holding the answer. A
-- lease that runs out belongs to a process that died, so a retry of the same
-- request may take over. Finished rows answer for 7 days. After that the row
-- counts as gone, whether or not a retention job has removed it yet.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.idempotency_keys (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- Chosen by the client, so the format is narrow enough to refuse free text.
  idempotency_key text not null
    constraint idempotency_keys_key_format check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  -- Covers the method, the path, the query and the body bytes.
  request_sha256 ujira.hash32 not null,
  lease_id uuid,
  lease_expires_at timestamptz,
  -- The request id of the attempt that finished, which its answer quotes.
  request_id text,
  response_status bigint,
  response_body text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint idempotency_keys_tenant_key unique (principal_id, project_id, idempotency_key),
  constraint idempotency_keys_running_or_finished check (
    (
      lease_id is not null
      and lease_expires_at is not null
      and request_id is null
      and response_status is null
      and response_body is null
    )
    or (
      lease_id is null
      and lease_expires_at is null
      and request_id is not null
      and response_body is not null
      -- A 5xx or a 429 is never stored: it says to try again, so a retry must run.
      and response_status between 200 and 499
      and response_status <> 429
    )
  ),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- For the retention job, which removes expired rows in batches.
create index idempotency_keys_expires_at on ujira.idempotency_keys (expires_at);

select ujira.apply_tenant_policies('ujira.idempotency_keys');

-- No grant to the reader: a stored answer is a copy of a response, and nothing
-- reports on these rows. None to the worker either: the key belongs to an HTTP
-- request, and a job is made idempotent by its job key and the payout's own.
grant select, insert, update on ujira.idempotency_keys to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.idempotency_keys;

reset role;
