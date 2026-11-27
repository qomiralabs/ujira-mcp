-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- A create has no mandate row yet, so its signing request carries what that
-- row will need once the chain has the contract: the name the principal gave
-- it and the project key the factory call names as agent. Every other action
-- carries neither.
--
-- The columns are new and empty, and the checks and the key are added not
-- valid, so nothing here scans the table under a lock; the next migration
-- validates them on their own.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.signing_requests
  add column mandate_name text,
  add column agent_key_id uuid;

alter table ujira.signing_requests
  add constraint signing_requests_mandate_name_format check (
    char_length(mandate_name) between 1 and 200
    and mandate_name = btrim(mandate_name)
    and mandate_name !~ '[[:cntrl:]]'
  ) not valid;

alter table ujira.signing_requests
  add constraint signing_requests_create_only_fields check (
    action = 'create' or (mandate_name is null and agent_key_id is null)
  ) not valid;

alter table ujira.signing_requests
  add constraint signing_requests_agent_key
    foreign key (principal_id, project_id, agent_key_id)
    references ujira.agent_keys (principal_id, project_id, id) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.signing_requests
  drop constraint signing_requests_agent_key,
  drop constraint signing_requests_create_only_fields,
  drop constraint signing_requests_mandate_name_format,
  drop column agent_key_id,
  drop column mandate_name;

reset role;
