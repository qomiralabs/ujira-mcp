-- contract
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Checks the rows already in ujira.api_tokens against the constraints the last
-- two migrations added, in a transaction of its own, so the scan takes only a
-- lock that lets traffic through.
--
-- One block because a no-transaction migration sends one statement, and the role
-- and timeouts have to be set inside it.

-- Up Migration
do $validate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.api_tokens validate constraint api_tokens_rotated_from_fkey;
  alter table ujira.api_tokens validate constraint api_tokens_scopes_known;
  alter table ujira.api_tokens validate constraint api_tokens_expires_at_required;
end
$validate$;

-- Down Migration
do $unvalidate$
begin
  set local lock_timeout = '5s';
  set local statement_timeout = '60s';
  set local role ujira_owner;
  alter table ujira.api_tokens drop constraint api_tokens_rotated_from_fkey;
  alter table ujira.api_tokens
    add constraint api_tokens_rotated_from_fkey
      foreign key (principal_id, project_id, rotated_from_id)
      references ujira.api_tokens (principal_id, project_id, id)
      not valid;
  alter table ujira.api_tokens drop constraint api_tokens_scopes_known;
  alter table ujira.api_tokens
    add constraint api_tokens_scopes_known check (
      cardinality(scopes) between 1 and 10
      and scopes <@ array[
        'payouts:read',
        'payouts:write',
        'approvals:write',
        'recipients:read',
        'recipients:write',
        'mandates:read',
        'mandates:write',
        'receipts:read',
        'webhooks:manage',
        'corridors:read'
      ]::text[]
    ) not valid;
  alter table ujira.api_tokens drop constraint api_tokens_expires_at_required;
  alter table ujira.api_tokens
    add constraint api_tokens_expires_at_required check (expires_at is not null) not valid;
end
$unvalidate$;
