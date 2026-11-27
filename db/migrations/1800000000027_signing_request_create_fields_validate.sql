-- contract
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Checks the signing requests already stored against the create only fields,
-- in a transaction of its own, so the scan takes only a lock that lets traffic
-- through. Every row written before them has both columns empty, which every
-- check allows, so this cannot fail on data the previous release wrote.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.signing_requests validate constraint signing_requests_mandate_name_format;
  alter table ujira.signing_requests validate constraint signing_requests_create_only_fields;
  alter table ujira.signing_requests validate constraint signing_requests_agent_key;
end
$validate$;

-- Down Migration
do $unvalidate$
declare
  con text;
  definition text;
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  -- The same constraints, not valid again, so the previous migration's down still fits.
  foreach con in array array[
    'signing_requests_mandate_name_format',
    'signing_requests_create_only_fields',
    'signing_requests_agent_key'
  ] loop
    select pg_get_constraintdef(c.oid) into definition
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'ujira.signing_requests'::regclass
       and c.conname = con;
    execute format('alter table ujira.signing_requests drop constraint %I', con);
    execute format(
      'alter table ujira.signing_requests add constraint %I %s not valid',
      con,
      definition
    );
  end loop;
end
$unvalidate$;
