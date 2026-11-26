-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Roles, ownership and grants for schema ujira, the tenant context
-- functions, the row level security template every tenant table applies,
-- and the shared triggers.
--
-- Tenant isolation holds in the database, not only in code: the service
-- roles cannot bypass row level security, every tenant table forces it, and
-- the policies read the tenant from transaction local settings that
-- current_principal_id() refuses to use outside the transaction that set
-- them.
--
-- Roles are shared by every database on the server, so they are created only
-- when missing and the down section never drops them: another database may
-- own objects through them. Their role level timeouts stay too, for the
-- same reason.
--
-- Migrations after this one `set local role ujira_owner` after their
-- timeouts, so what they create is owned by the owner role and not by
-- whoever ran them, and `reset role` at the end of the section, because the
-- runner records the migration in the same transaction as the session user.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $roles$
declare
  login_role text;
begin
  -- Owns every object in ujira and never logs in. Ownership is what lets a
  -- role skip row level security, so no login role holds it directly.
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_owner') then
    create role ujira_owner nologin nobypassrls;
  end if;
  -- One login per job, so each holds only the rights its job needs:
  -- migrator runs migrations as the owner; app serves requests; worker runs
  -- the queued jobs, each inside a tenant transaction; reader reads.
  -- Passwords are set outside migrations.
  foreach login_role in array array[
    'ujira_migrator', 'ujira_app', 'ujira_worker', 'ujira_reader'
  ] loop
    if not exists (select from pg_catalog.pg_roles where rolname = login_role) then
      execute format('create role %I login noinherit nobypassrls', login_role);
    end if;
    -- Converges a role that existed before this migration as well.
    execute format('alter role %I nobypassrls', login_role);
  end loop;
  -- The session running migrations must be able to become the owner. A
  -- superuser already can; on a managed server the bootstrap role cannot
  -- until it is granted membership.
  if not pg_catalog.pg_has_role(current_user, 'ujira_owner', 'member') then
    execute format('grant ujira_owner to %I', current_user);
  end if;
end
$roles$;

grant ujira_owner to ujira_migrator;

-- Server side limits for the app role, under the transaction pooler's own
-- 8 seconds, so a runaway statement or an abandoned transaction is cut off
-- by the database even if a client forgets its own limit. The worker gets
-- none: it holds a session connection open for the queue's notifications,
-- and its tenant transactions carry their own limits.
alter role ujira_app set statement_timeout = '5s';
alter role ujira_app set lock_timeout = '3s';
alter role ujira_app set idle_in_transaction_session_timeout = '10s';

alter schema ujira owner to ujira_owner;
alter domain ujira.amount owner to ujira_owner;
alter domain ujira.scale owner to ujira_owner;
alter domain ujira.hash32 owner to ujira_owner;
alter table ujira.chains owner to ujira_owner;
alter table ujira.currencies owner to ujira_owner;
alter table ujira.currency_scales owner to ujira_owner;
alter table ujira.settlement_tokens owner to ujira_owner;
alter table ujira.status_transitions owner to ujira_owner;

set local role ujira_owner;

-- Postgres makes every new function executable, and every new type usable,
-- by PUBLIC, which on Supabase includes anon, authenticated and
-- service_role. The owner's defaults drop that, and each grant below names
-- its roles.
alter default privileges for role ujira_owner revoke execute on functions from public;
alter default privileges for role ujira_owner revoke usage on types from public;

revoke all on schema ujira from public;
grant usage on schema ujira to ujira_app, ujira_worker, ujira_reader;

revoke usage on domain ujira.amount, ujira.scale, ujira.hash32 from public;
grant usage on domain ujira.amount, ujira.scale, ujira.hash32
  to ujira_app, ujira_worker, ujira_reader;

grant select on
  ujira.chains,
  ujira.currencies,
  ujira.currency_scales,
  ujira.settlement_tokens,
  ujira.status_transitions
  to ujira_app, ujira_worker, ujira_reader;

-- The principal of the current transaction. Refuses, with UJ001, when the
-- transaction set none, and when the settings were set by another
-- transaction: ujira.txid holds the id of the transaction that set them, so
-- a value that survived into a later transaction on a pooled connection is
-- refused rather than used.
create function ujira.current_principal_id() returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
declare
  principal text := current_setting('ujira.principal_id', true);
  bound text := current_setting('ujira.txid', true);
begin
  if principal is null or principal = '' then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: this transaction did not set one';
  end if;
  if bound is distinct from txid_current()::text then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: the settings belong to another transaction';
  end if;
  return principal::uuid;
end
$fn$;

-- True when the transaction reads every project of its principal. That
-- scope is read only: the insert and update policies compare against
-- current_project_id(), which is null under it, so no row can pass.
create function ujira.project_scope_all() returns boolean
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
declare
  scope text := current_setting('ujira.scope', true);
begin
  perform ujira.current_principal_id();
  if scope = 'all' then
    return true;
  end if;
  if scope = 'project' then
    return false;
  end if;
  raise exception using
    errcode = 'UJ001',
    message = 'no tenant context: the scope is neither project nor all';
end
$fn$;

-- The project of the current transaction, or null under scope all.
create function ujira.current_project_id() returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog
as $fn$
declare
  project text := current_setting('ujira.project_id', true);
begin
  if ujira.project_scope_all() then
    return null;
  end if;
  if project is null or project = '' then
    raise exception using
      errcode = 'UJ001',
      message = 'no tenant context: this transaction set no project';
  end if;
  return project::uuid;
end
$fn$;

grant execute on function
  ujira.current_principal_id(),
  ujira.project_scope_all(),
  ujira.current_project_id()
  to ujira_app, ujira_worker, ujira_reader;

-- The policy template. A migration that creates a tenant table calls this
-- once, as the owner, and then grants the commands the app, the worker and
-- the reader need. Reads see the transaction's principal, and its project
-- unless the scope is all. Inserts and updates must name the transaction's
-- principal and project. The worker writes under the same policies as the
-- app, because every job runs inside a tenant transaction. The owner policy
-- is for backfills run by migrations. There is deliberately no delete
-- policy: a tenant row is never deleted by the app, and the catalog test
-- fails if a delete is granted without one.
create function ujira.apply_tenant_policies(target regclass) returns void
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  own_tenant constant text :=
    'principal_id = ujira.current_principal_id() and project_id = ujira.current_project_id()';
begin
  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);
  execute format(
    'create policy tenant_read on %s for select to ujira_app, ujira_worker, ujira_reader using ('
      || 'principal_id = ujira.current_principal_id() and '
      || '(ujira.project_scope_all() or project_id = ujira.current_project_id()))',
    target
  );
  execute format(
    'create policy tenant_insert on %s for insert to ujira_app, ujira_worker with check (%s)',
    target, own_tenant
  );
  execute format(
    'create policy tenant_update on %s for update to ujira_app, ujira_worker using (%s) with check (%s)',
    target, own_tenant, own_tenant
  );
  execute format(
    'create policy owner_all on %s for all to ujira_owner using (true) with check (true)',
    target
  );
end
$fn$;

-- For append only tables: any update or delete is refused with UJ002.
create function ujira.forbid_mutation() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  raise exception using
    errcode = 'UJ002',
    message = format('%I.%I is append only: %s is refused', tg_table_schema, tg_table_name, lower(tg_op));
end
$fn$;

-- For a table with a status machine, as a before update trigger whose one
-- argument names the machine: a status change that is not a row of
-- ujira.status_transitions is refused with UJ004.
create function ujira.check_transition() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if new.status is distinct from old.status and not exists (
    select 1
      from ujira.status_transitions as t
     where t.machine = tg_argv[0]
       and t.from_status = old.status
       and t.to_status = new.status
  ) then
    raise exception using
      errcode = 'UJ004',
      message = format('%s cannot move from %s to %s', tg_argv[0], old.status, new.status);
  end if;
  return new;
end
$fn$;

-- Keeps updated_at true without every writer remembering to set it.
create function ujira.touch() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

-- The runner records the migration in this same transaction, as the
-- session user, which the owner role is not.
reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function ujira.touch();
drop function ujira.check_transition();
drop function ujira.forbid_mutation();
drop function ujira.apply_tenant_policies(regclass);
drop function ujira.current_project_id();
drop function ujira.project_scope_all();
drop function ujira.current_principal_id();

revoke select on
  ujira.chains,
  ujira.currencies,
  ujira.currency_scales,
  ujira.settlement_tokens,
  ujira.status_transitions
  from ujira_app, ujira_worker, ujira_reader;
revoke usage on domain ujira.amount, ujira.scale, ujira.hash32
  from ujira_app, ujira_worker, ujira_reader;
grant usage on domain ujira.amount, ujira.scale, ujira.hash32 to public;
revoke usage on schema ujira from ujira_app, ujira_worker, ujira_reader;

alter default privileges for role ujira_owner grant execute on functions to public;
alter default privileges for role ujira_owner grant usage on types to public;

alter table ujira.status_transitions owner to current_user;
alter table ujira.settlement_tokens owner to current_user;
alter table ujira.currency_scales owner to current_user;
alter table ujira.currencies owner to current_user;
alter table ujira.chains owner to current_user;
alter domain ujira.hash32 owner to current_user;
alter domain ujira.scale owner to current_user;
alter domain ujira.amount owner to current_user;
alter schema ujira owner to current_user;
