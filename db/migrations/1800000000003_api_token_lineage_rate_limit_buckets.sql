-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Rotation lineage on API tokens, and the buckets behind the API rate limits.
--
-- The buckets are unlogged because a rate limit counter is worth nothing after
-- a crash: the worst a lost row does is hand back a full bucket, and every
-- request writes one, so it stays out of the WAL. They hold no customer data,
-- so a key is a digest of what is being limited, and the format check refuses
-- anything else, a raw id included. They belong to no tenant, so no service
-- role can read them: the app reaches them only through the one function a
-- later migration adds, which runs as ujira_fn_rate_limits.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_rate_limits') then
    create role ujira_fn_rate_limits nologin noinherit nobypassrls;
  end if;
  alter role ujira_fn_rate_limits nobypassrls;
end
$roles$;

grant ujira_fn_rate_limits to ujira_owner;

set local role ujira_owner;

alter table ujira.api_tokens add column rotated_from_id uuid;

-- Both tenant columns are in the key, so a token can only descend from a token
-- of its own project. Checked against existing rows by a later migration, so
-- adding it here takes no scan.
alter table ujira.api_tokens
  add constraint api_tokens_rotated_from_fkey
    foreign key (principal_id, project_id, rotated_from_id)
    references ujira.api_tokens (principal_id, project_id, id)
    not valid;

create unlogged table ujira.rate_limit_buckets (
  bucket_key text primary key
    constraint rate_limit_buckets_key_format check (bucket_key ~ '^[a-z_]{1,32}:[0-9a-f]{64}$'),
  -- Fractional, because a bucket refills between requests.
  tokens numeric(18, 6) not null
    constraint rate_limit_buckets_tokens_not_negative check (tokens >= 0),
  refilled_at timestamptz not null
);

alter table ujira.rate_limit_buckets enable row level security;
alter table ujira.rate_limit_buckets force row level security;
create policy owner_all on ujira.rate_limit_buckets for all to ujira_owner
  using (true) with check (true);
create policy take_tokens on ujira.rate_limit_buckets for all to ujira_fn_rate_limits
  using (true) with check (true);

grant usage on schema ujira to ujira_fn_rate_limits;
grant select, insert, update on ujira.rate_limit_buckets to ujira_fn_rate_limits;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.rate_limit_buckets;
alter table ujira.api_tokens drop constraint api_tokens_rotated_from_fkey;
alter table ujira.api_tokens drop column rotated_from_id;
revoke usage on schema ujira from ujira_fn_rate_limits;

-- The role and the owner's membership of it stay: roles are shared by every
-- database on the server, and another one may still hand functions to it.
reset role;
