-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- A name a person can recognize a key by, in the list of a project's keys.
-- Null only on a key made before keys had names. The check binds new writes
-- at once and is validated against the rows already there by a later
-- migration, so this holds no long lock.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens add column name text;
alter table ujira.api_tokens
  add constraint api_tokens_name_length check (char_length(name) between 1 and 100) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens drop constraint api_tokens_name_length;
alter table ujira.api_tokens drop column name;

reset role;
