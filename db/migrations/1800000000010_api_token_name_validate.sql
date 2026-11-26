-- contract
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Checks the rows already in ujira.api_tokens against the name check, in a
-- transaction of its own, so the scan takes only a lock that lets traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.api_tokens validate constraint api_tokens_name_length;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.api_tokens drop constraint api_tokens_name_length;
  alter table ujira.api_tokens
    add constraint api_tokens_name_length check (char_length(name) between 1 and 100) not valid;
end
$unvalidate$;
