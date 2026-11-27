-- contract
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- What the database and the API agree a token is: one to ten scopes from the
-- closed list, and an expiry. The list is the one the API authorizes against, so
-- a change to it is a migration and a change to the API together.
--
-- Added as NOT VALID, which binds new writes at once and takes no scan. The next
-- two migrations check the rows already there and then make the expiry a real
-- NOT NULL. If a row ever fails that check, the deploy stops there rather than
-- guessing what it should be.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Taking these away is the point of this migration: a token named with no scopes
-- must fail, and the old bound is replaced by the tighter one below.
alter table ujira.api_tokens alter column scopes drop default;
alter table ujira.api_tokens drop constraint api_tokens_scopes_bounded;
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
alter table ujira.api_tokens
  add constraint api_tokens_expires_at_required check (expires_at is not null) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens drop constraint api_tokens_expires_at_required;
alter table ujira.api_tokens drop constraint api_tokens_scopes_known;
alter table ujira.api_tokens
  add constraint api_tokens_scopes_bounded check (cardinality(scopes) <= 32) not valid;
alter table ujira.api_tokens alter column scopes set default '{}';

reset role;
