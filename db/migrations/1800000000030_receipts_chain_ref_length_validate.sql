-- contract
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Checks the receipts already stored against the new reference check, in a
-- transaction of its own, so the scan takes only a lock that lets traffic
-- through. The check it replaced could not accept any reference, so every row
-- already there has none, which the new check allows: this cannot fail on
-- data the previous release wrote.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.receipts validate constraint receipts_chain_ref_format;
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
   where c.conrelid = 'ujira.receipts'::regclass
     and c.conname = 'receipts_chain_ref_format';
  alter table ujira.receipts drop constraint receipts_chain_ref_format;
  execute format(
    'alter table ujira.receipts add constraint receipts_chain_ref_format %s not valid',
    definition
  );
end
$unvalidate$;
