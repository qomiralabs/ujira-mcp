-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The job queue's two schemas and the one way a payout job is created.
--
-- Graphile Worker keeps its tables in schema graphile_worker. The worker login
-- installs them after this runs (installJobQueue in src/db/queue.ts), so the
-- pinned library version writes its own tables and ujira_worker owns them.
-- It has to: those tables enable row level security with no policies, so only
-- their owner can use them. Owning the queue gives the worker no way around
-- tenant isolation, because it still owns nothing in schema ujira and its
-- tenant transactions run under the same policies as the app's.
--
-- The installer creates its schema and its ledger table only when the ledger
-- is missing, and that needs CREATE on the database. Both are created here
-- instead, so the worker login never holds that right: a role that can create
-- schemas could put one in front of what another role resolves. The ledger's
-- shape is the one the pinned version creates; an upgrade checks it again.
--
-- The app cannot add a job through graphile_worker.add_job: it is security
-- invoker over tables the app has no rights on. ujira_jobs.enqueue_payout is
-- the only way in. It takes the tenant from the transaction and never from the
-- caller, and it builds the payload, the queue and the job key itself, so a
-- job exists only if the payout write beside it commits, and no caller can
-- name another tenant or another tenant's queue.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The session must be able to act as the worker to hand it the schemas. A
-- superuser already can; a managed server's bootstrap role cannot until it is
-- a member.
do $member$
begin
  if not pg_catalog.pg_has_role(current_user, 'ujira_worker', 'member') then
    execute format('grant ujira_worker to %I', current_user);
  end if;
end
$member$;

create schema graphile_worker authorization ujira_worker;
create schema ujira_jobs authorization ujira_worker;

-- A new schema grants nothing to PUBLIC, but a function or a type created in
-- it later is executable or usable by PUBLIC unless the owner's defaults say
-- otherwise, and every later library version adds functions of its own. So
-- this is a default, set before the install, not a one off.
alter default privileges for role ujira_worker revoke execute on functions from public;
alter default privileges for role ujira_worker revoke usage on types from public;

set local role ujira_worker;

create table graphile_worker.migrations (
  id int primary key,
  ts timestamptz default now() not null,
  breaking boolean not null default false
);

-- Every payout job goes through here. The tenant is the transaction's, read
-- through the same functions the policies use, so a context that is missing,
-- left over from another transaction or read only is refused with UJ001.
--
-- The queue follows from the task. payout.advance signs with the project's
-- agent key, so it runs one at a time per project; payout.execute signs with
-- the one executor key, so it runs one at a time overall; receipt.issue signs
-- nothing and runs in parallel. A queue that serialises a key is what keeps
-- the key from racing its own sequence number.
--
-- The job key carries the project as well as the payout. Payout ids are unique
-- already, but a key without the tenant would let a wrong id from one tenant
-- replace another tenant's job in place; with it, two tenants can never share
-- a key. A second enqueue of the same key replaces the waiting job, so it
-- collapses; one that finds the job running adds the next run behind it.
--
-- run_at is clock_timestamp(), not now(): jobs are claimed by run time with no
-- tie break, and now() is the same for every job of one transaction.
create function ujira_jobs.enqueue_payout(p_task text, p_payout_id uuid)
  returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  v_principal uuid := ujira.current_principal_id();
  v_project uuid := ujira.current_project_id();
  v_queue text;
  v_job_id bigint;
begin
  if v_project is null then
    raise exception using
      errcode = 'UJ001',
      message = 'a job belongs to one project: scope all cannot enqueue';
  end if;
  if p_payout_id is null then
    raise exception using errcode = '22004', message = 'p_payout_id must not be null';
  end if;
  if p_task = 'payout.advance' then
    v_queue := 'agent:' || v_project::text;
  elsif p_task = 'payout.execute' then
    v_queue := 'executor';
  elsif p_task = 'receipt.issue' then
    v_queue := null;
  else
    raise exception using
      errcode = '22023',
      message = 'unknown payout task: use payout.advance, payout.execute or receipt.issue';
  end if;

  select j.id into v_job_id
    from graphile_worker.add_job(
      identifier   => p_task,
      payload      => json_build_object(
                        'principalId', v_principal::text,
                        'projectId', v_project::text,
                        'payoutId', p_payout_id::text
                      ),
      queue_name   => v_queue,
      run_at       => clock_timestamp(),
      max_attempts => 10,
      job_key      => v_project::text || ':payout:' || p_payout_id::text || ':' || p_task,
      job_key_mode => 'replace'
    ) as j;
  return v_job_id;
end
$fn$;

revoke all on function ujira_jobs.enqueue_payout(text, uuid) from public;
grant usage on schema ujira_jobs to ujira_app;
grant execute on function ujira_jobs.enqueue_payout(text, uuid) to ujira_app;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refused once the library has installed its tables, which is the right
-- answer: rolling this back must not quietly destroy a queue with jobs in it.
-- Indexes are left out because the ledger made above has one of its own, its
-- primary key, and counting it refused every rollback, installed or not. An
-- installed index always sits on an installed table, so nothing is missed.
do $installed$
begin
  if exists (
    select 1
      from pg_catalog.pg_class as c
      join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'graphile_worker'
       and c.relname <> 'migrations'
       and c.relkind <> 'i'
  ) then
    raise exception using
      errcode = '2BP01',
      message = 'the job queue is installed in graphile_worker; drain and drop it by hand first';
  end if;
end
$installed$;

set local role ujira_worker;

drop function ujira_jobs.enqueue_payout(text, uuid);
drop table graphile_worker.migrations;

reset role;

drop schema ujira_jobs;
drop schema graphile_worker;

alter default privileges for role ujira_worker grant execute on functions to public;
alter default privileges for role ujira_worker grant usage on types to public;
