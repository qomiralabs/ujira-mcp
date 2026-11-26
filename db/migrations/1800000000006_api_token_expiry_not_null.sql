-- contract
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Makes the expiry a real NOT NULL. The validated check from the last migration
-- lets Postgres take this without scanning the table, and once it holds the
-- check says nothing more, so it goes.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens alter column expires_at set not null;
alter table ujira.api_tokens drop constraint api_tokens_expires_at_required;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens
  add constraint api_tokens_expires_at_required check (expires_at is not null);
alter table ujira.api_tokens alter column expires_at drop not null;

reset role;
