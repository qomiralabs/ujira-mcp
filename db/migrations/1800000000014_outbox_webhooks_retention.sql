-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The outbox, webhook endpoints and deliveries, and what the retention role may
-- touch. A status change writes its event in the same transaction, so what reaches
-- a webhook is exactly what was written.
--
-- Retention has no tenant context, so it reaches across tenants, and the policies
-- are what keep it safe: it can see only rows already past their window, and of
-- those only the columns it needs to find them, never a payload or a stored answer.
-- The role cannot log in: no service needs a standing connection with these
-- rights, and a function it owns can lend them to the prune job one call at a time.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_retention') then
    create role ujira_retention nologin noinherit nobypassrls;
  end if;
  -- Only when it needs it: Postgres 16 and later refuse any change to the
  -- attribute, even taking it away, from a login that does not hold it.
  if exists (
    select from pg_catalog.pg_roles where rolname = 'ujira_retention' and rolbypassrls
  ) then
    alter role ujira_retention nobypassrls;
  end if;
end
$roles$;

set local role ujira_owner;

grant usage on schema ujira to ujira_retention;

create table ujira.outbox_events (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- The read order. A sequence can commit out of order, which tx_id accounts for.
  seq bigint generated always as identity,
  -- Lets a reader stop before any transaction still in flight, so it can never
  -- move its cursor past a lower seq that has yet to commit.
  tx_id xid8 not null default pg_current_xact_id(),
  event_type text not null
    constraint outbox_events_type_format check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- Exactly what a webhook will carry: ids and amounts, never personal data.
  payload jsonb not null
    constraint outbox_events_payload_object check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  constraint outbox_events_tenant_key unique (principal_id, project_id, id),
  -- What a delivery's foreign key needs, so a delivery ages with its event.
  constraint outbox_events_delivery_key unique (principal_id, project_id, id, created_at),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create index outbox_events_read on ujira.outbox_events (principal_id, project_id, seq);
create index outbox_events_retention on ujira.outbox_events (created_at);

create table ujira.webhook_endpoints (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  url text not null
    constraint webhook_endpoints_url_format check (url ~ '^https://' and char_length(url) <= 2048),
  -- Where the secret manager holds this endpoint's signing secret. The secret
  -- itself never reaches the database.
  secret_ref text not null
    constraint webhook_endpoints_secret_ref_length check (char_length(secret_ref) between 1 and 256),
  event_types text[] not null
    constraint webhook_endpoints_has_events check (cardinality(event_types) > 0),
  status text not null default 'enabled'
    constraint webhook_endpoints_status check (status in ('enabled', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhook_endpoints_url_per_project unique (principal_id, project_id, url),
  constraint webhook_endpoints_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- One row per attempt. It keeps a code and a status, never the receiver's response
-- body, which could hold anything.
create table ujira.webhook_deliveries (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null,
  event_id uuid not null,
  event_created_at timestamptz not null,
  -- Bounded, so it reads back exactly as a JavaScript number.
  attempt bigint not null
    constraint webhook_deliveries_attempt_range check (attempt between 1 and 1000),
  status text not null
    constraint webhook_deliveries_status check (status in ('succeeded', 'failed', 'dead_letter')),
  response_status bigint
    constraint webhook_deliveries_response_range check (response_status between 100 and 599),
  error_code text
    constraint webhook_deliveries_error_length check (char_length(error_code) between 1 and 64),
  created_at timestamptz not null default now(),
  constraint webhook_deliveries_per_attempt unique (principal_id, project_id, endpoint_id, event_id, attempt),
  foreign key (principal_id, project_id, endpoint_id)
    references ujira.webhook_endpoints (principal_id, project_id, id),
  foreign key (principal_id, project_id, event_id, event_created_at)
    references ujira.outbox_events (principal_id, project_id, id, created_at)
);

create index webhook_deliveries_by_event on ujira.webhook_deliveries (principal_id, project_id, event_id);
create index webhook_deliveries_retention on ujira.webhook_deliveries (event_created_at);

-- Append only, except for the one role whose whole job is to remove expired rows.
-- That role can only see expired rows, so this does not reach a live one.
create function ujira.forbid_mutation_except_retention() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' and current_user = 'ujira_retention' then
    return old;
  end if;
  raise exception using
    errcode = 'UJ002',
    message = format('%I.%I is append only: %s is refused', tg_table_schema, tg_table_name, lower(tg_op));
end
$fn$;

create trigger outbox_events_append_only before update or delete on ujira.outbox_events
  for each row execute function ujira.forbid_mutation_except_retention();
create trigger outbox_events_no_truncate before truncate on ujira.outbox_events
  for each statement execute function ujira.forbid_mutation();
create trigger webhook_deliveries_append_only before update or delete on ujira.webhook_deliveries
  for each row execute function ujira.forbid_mutation_except_retention();
create trigger webhook_deliveries_no_truncate before truncate on ujira.webhook_deliveries
  for each statement execute function ujira.forbid_mutation();
create trigger webhook_endpoints_touch before update on ujira.webhook_endpoints
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.outbox_events');
select ujira.apply_tenant_policies('ujira.webhook_endpoints');
select ujira.apply_tenant_policies('ujira.webhook_deliveries');

grant select, insert on ujira.outbox_events to ujira_app;
grant select, insert on ujira.webhook_deliveries to ujira_app;
grant select, insert on ujira.webhook_endpoints to ujira_app;
grant update (url, secret_ref, event_types, status) on ujira.webhook_endpoints to ujira_app;
grant select on ujira.outbox_events, ujira.webhook_deliveries to ujira_reader;
-- A dashboard can list endpoints without learning where a secret lives.
grant select (principal_id, project_id, id, url, event_types, status, created_at, updated_at)
  on ujira.webhook_endpoints to ujira_reader;
-- The worker's jobs move payouts between states, and each move writes its event
-- in the job's own transaction, under the same tenant policies as the app.
grant select, insert on ujira.outbox_events to ujira_worker;

create policy retention_read on ujira.idempotency_keys for select to ujira_retention
  using (expires_at < now());
create policy retention_delete on ujira.idempotency_keys for delete to ujira_retention
  using (expires_at < now());
create policy retention_read on ujira.outbox_events for select to ujira_retention
  using (created_at < now() - interval '30 days');
create policy retention_delete on ujira.outbox_events for delete to ujira_retention
  using (created_at < now() - interval '30 days');
create policy retention_read on ujira.webhook_deliveries for select to ujira_retention
  using (event_created_at < now() - interval '30 days');
create policy retention_delete on ujira.webhook_deliveries for delete to ujira_retention
  using (event_created_at < now() - interval '30 days');

grant select (id, expires_at), delete on ujira.idempotency_keys to ujira_retention;
grant select (id, created_at), delete on ujira.outbox_events to ujira_retention;
grant select (id, event_created_at), delete on ujira.webhook_deliveries to ujira_retention;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop policy retention_delete on ujira.idempotency_keys;
drop policy retention_read on ujira.idempotency_keys;
revoke select (id, expires_at), delete on ujira.idempotency_keys from ujira_retention;
drop table ujira.webhook_deliveries;
drop table ujira.webhook_endpoints;
drop table ujira.outbox_events;
drop function ujira.forbid_mutation_except_retention();
revoke usage on schema ujira from ujira_retention;

reset role;
