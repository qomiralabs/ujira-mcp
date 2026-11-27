-- contract
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Checks the rows already in ujira.audit_log against the widened catalog, in a
-- transaction of its own, so the scan takes only a lock that lets traffic
-- through. Every row the earlier catalog allowed is still allowed, so this
-- cannot fail on data the previous release wrote.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.audit_log validate constraint audit_log_action_known;
end
$validate$;

-- Down Migration
do $unvalidate$
declare
  definition text;
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  -- The same check, not valid again, so the previous migration's down still fits.
  select pg_get_constraintdef(c.oid) into definition
    from pg_catalog.pg_constraint as c
   where c.conrelid = 'ujira.audit_log'::regclass
     and c.conname = 'audit_log_action_known';
  alter table ujira.audit_log drop constraint audit_log_action_known;
  execute format(
    'alter table ujira.audit_log add constraint audit_log_action_known %s not valid',
    definition
  );
end
$unvalidate$;
