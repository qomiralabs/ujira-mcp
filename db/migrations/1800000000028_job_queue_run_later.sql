-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- A payout job that runs later. A payout waiting for its approvers has nothing
-- on chain to act on until they sign, so payout.advance looks again after a
-- delay instead of failing its way through the retry budget, which would end
-- an untroubled payout as a dead letter.
--
-- Only the worker calls this: it owns the function, and nobody is granted it.
-- Everything else is enqueue_payout's: the tenant comes from the transaction,
-- the queue from the task and the key carries the project, so a later job
-- replaces a waiting one of the same payout and task, and one that finds that
-- job running is added behind it. The delay is bounded, so a bug cannot park a
-- payout for days.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- As in the job queue migration: the session must be able to act as the
-- worker to create a function the worker owns.
do $member$
begin
  if not pg_catalog.pg_has_role(current_user, 'ujira_worker', 'member') then
    execute format('grant ujira_worker to %I', current_user);
  end if;
end
$member$;

set local role ujira_worker;

create function ujira_jobs.enqueue_payout_later(
  p_task text,
  p_payout_id uuid,
  p_delay_seconds integer
)
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
  if p_delay_seconds is null or p_delay_seconds < 1 or p_delay_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'p_delay_seconds must be from 1 to 3600';
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
      run_at       => clock_timestamp() + make_interval(secs => p_delay_seconds),
      max_attempts => 10,
      job_key      => v_project::text || ':payout:' || p_payout_id::text || ':' || p_task,
      job_key_mode => 'replace'
    ) as j;
  return v_job_id;
end
$fn$;

revoke all on function ujira_jobs.enqueue_payout_later(text, uuid, integer) from public;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $member$
begin
  if not pg_catalog.pg_has_role(current_user, 'ujira_worker', 'member') then
    execute format('grant ujira_worker to %I', current_user);
  end if;
end
$member$;

set local role ujira_worker;

drop function ujira_jobs.enqueue_payout_later(text, uuid, integer);

reset role;
