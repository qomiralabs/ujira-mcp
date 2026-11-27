-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The audit log: every administrative action, append only and hash chained per
-- principal, so a removed or altered row breaks the chain and the verifier says
-- where. Each row's hash covers the one before it, and audit_heads holds where
-- the chain has reached, so removing the newest rows shows as well.
--
-- Metadata keys come from an allowlist, because free form metadata is how
-- personal data ends up in a log that can never be edited.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_audit') then
    create role ujira_fn_audit nologin noinherit nobypassrls;
  end if;
  -- Only when it needs it: Postgres 16 and later refuse any change to the
  -- attribute, even taking it away, from a login that does not hold it.
  if exists (
    select from pg_catalog.pg_roles where rolname = 'ujira_fn_audit' and rolbypassrls
  ) then
    alter role ujira_fn_audit nobypassrls;
  end if;
end
$roles$;

grant ujira_fn_audit to ujira_owner;

set local role ujira_owner;

-- Reference data, the same for every tenant. Adding a key is a migration, and
-- so a review of whether it could ever hold personal data.
create table ujira.audit_metadata_keys (
  key text primary key
    constraint audit_metadata_keys_format check (key ~ '^[a-z][a-z0-9_]{0,63}$')
);

insert into ujira.audit_metadata_keys (key) values
  ('setting'),
  ('old_value'),
  ('new_value'),
  ('target_type'),
  ('target_id'),
  ('reason_code');

grant select on ujira.audit_metadata_keys to ujira_fn_audit;

-- Where each principal's chain has reached. One row per principal, and its lock
-- is what puts concurrent writers of one chain in order.
create table ujira.audit_heads (
  principal_id uuid primary key references ujira.principals (id),
  last_seq bigint not null default 0,
  last_hash ujira.hash32 not null
);

create table ujira.audit_log (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  seq bigint not null,
  action text not null
    constraint audit_log_action_format check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  actor_kind text not null
    constraint audit_log_actor_kind check (actor_kind in ('member', 'token', 'system')),
  -- A member's or a token's id, never who they are. Null for the system.
  actor_id uuid,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  prev_hash ujira.hash32 not null,
  row_hash ujira.hash32 not null,
  constraint audit_log_actor_whole check ((actor_kind = 'system') = (actor_id is null)),
  constraint audit_log_seq unique (principal_id, seq),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- One definition of what a row's hash covers, used by the trigger that writes it
-- and by the verifier, so the two can never disagree. format's %L quotes every
-- field and leaves a null bare, so no field can run into the next, and jsonb
-- text is canonical, so a row has only one reading.
create function ujira.audit_row_hash(
  prev_hash bytea,
  principal_id uuid,
  project_id uuid,
  seq bigint,
  action text,
  actor_kind text,
  actor_id uuid,
  metadata jsonb,
  occurred_at timestamptz
) returns bytea
  language sql
  immutable
  set search_path = pg_catalog
as $fn$
  select sha256(
    prev_hash || convert_to(
      format(
        '%L|%L|%L|%L|%L|%L|%L|%L',
        principal_id,
        project_id,
        seq,
        action,
        actor_kind,
        actor_id,
        metadata::text,
        extract(epoch from occurred_at)::text
      ),
      'UTF8'
    )
  )
$fn$;

-- Refuses a metadata key the allowlist does not have, or nesting, which could
-- hide one.
create function ujira.audit_check_metadata(metadata jsonb) returns void
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
declare
  refused text;
begin
  if jsonb_typeof(metadata) <> 'object' then
    raise exception using errcode = 'UJ012', message = 'audit metadata must be an object';
  end if;
  select k into refused
    from jsonb_object_keys(metadata) as k
   where not exists (select 1 from ujira.audit_metadata_keys as a where a.key = k)
   limit 1;
  if refused is not null then
    raise exception using
      errcode = 'UJ012',
      message = format('audit metadata key %L is not on the allowlist', refused);
  end if;
  if exists (
    select 1 from jsonb_each(metadata) as e where jsonb_typeof(e.value) in ('object', 'array')
  ) then
    raise exception using errcode = 'UJ012', message = 'audit metadata values must be scalars';
  end if;
end
$fn$;

-- Locks the principal's head, then chains the row onto it. Whatever a caller
-- passes for the sequence and the hashes is overwritten. Runs as its own role,
-- because this is the only thing that may move a head.
create function ujira.audit_chain() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  head ujira.audit_heads%rowtype;
begin
  perform ujira.audit_check_metadata(new.metadata);
  insert into ujira.audit_heads (principal_id, last_seq, last_hash)
    values (new.principal_id, 0, decode(repeat('00', 32), 'hex'))
    on conflict (principal_id) do nothing;
  select * into head
    from ujira.audit_heads as h
   where h.principal_id = new.principal_id
   for update;
  new.seq := head.last_seq + 1;
  new.prev_hash := head.last_hash;
  new.occurred_at := clock_timestamp();
  new.row_hash := ujira.audit_row_hash(
    new.prev_hash::bytea,
    new.principal_id,
    new.project_id,
    new.seq,
    new.action,
    new.actor_kind,
    new.actor_id,
    new.metadata,
    new.occurred_at
  );
  update ujira.audit_heads as h
     set last_seq = new.seq,
         last_hash = new.row_hash
   where h.principal_id = new.principal_id;
  return new;
end
$fn$;

create trigger audit_log_chain before insert on ujira.audit_log
  for each row execute function ujira.audit_chain();
create trigger audit_log_append_only before update or delete on ujira.audit_log
  for each row execute function ujira.forbid_mutation();
create trigger audit_log_no_truncate before truncate on ujira.audit_log
  for each statement execute function ujira.forbid_mutation();
-- A head moves forward and never goes away: without it the newest rows could be
-- removed unseen.
create trigger audit_heads_no_delete before delete on ujira.audit_heads
  for each row execute function ujira.forbid_mutation();
create trigger audit_heads_no_truncate before truncate on ujira.audit_heads
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.audit_log');

alter table ujira.audit_heads enable row level security;
alter table ujira.audit_heads force row level security;
create policy tenant_read on ujira.audit_heads for select to ujira_app, ujira_reader
  using (principal_id = ujira.current_principal_id());
create policy owner_all on ujira.audit_heads for all to ujira_owner using (true) with check (true);
create policy audit_chain_all on ujira.audit_heads for all to ujira_fn_audit
  using (true) with check (true);

-- Only the app writes administrative actions. The worker's jobs move money,
-- and what they do is recorded on the payout and in the outbox instead.
grant select, insert on ujira.audit_log to ujira_app;
grant select on ujira.audit_log to ujira_reader;
grant select on ujira.audit_heads to ujira_app, ujira_reader;

grant usage on schema ujira to ujira_fn_audit;
grant select, insert, update on ujira.audit_heads to ujira_fn_audit;
grant usage on domain ujira.hash32 to ujira_fn_audit;
grant execute on function
  ujira.audit_row_hash(bytea, uuid, uuid, bigint, text, text, uuid, jsonb, timestamptz)
  to ujira_fn_audit, ujira_app, ujira_reader;
grant execute on function ujira.audit_check_metadata(jsonb) to ujira_fn_audit;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_audit;
alter function ujira.audit_chain() owner to ujira_fn_audit;
revoke create on schema ujira from ujira_fn_audit;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.audit_log;
drop table ujira.audit_heads;
drop function ujira.audit_chain();
drop function ujira.audit_check_metadata(jsonb);
drop function ujira.audit_row_hash(bytea, uuid, uuid, bigint, text, text, uuid, jsonb, timestamptz);
drop table ujira.audit_metadata_keys;
revoke usage on domain ujira.hash32 from ujira_fn_audit;
revoke usage on schema ujira from ujira_fn_audit;
revoke ujira_fn_audit from ujira_owner;
