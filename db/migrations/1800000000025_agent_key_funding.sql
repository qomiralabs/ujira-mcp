-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Whether a project's agent account exists on chain yet. A key is stored the
-- moment the project gets it, but its account only exists once something pays
-- the reserve, which on testnet is friendbot. That call can fail, so the row
-- says how far it got and why it stopped, and the dashboard can show it.
--
-- pending: not funded yet, and still being tried.
-- funded: the account exists. Final; an account is never unfunded.
-- failed: the attempts ran out. A person can ask for another try.
--
-- The error is a short code from the chain adapter, never a message, so no
-- address, URL or answer body from the network is ever stored here.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.agent_keys
  add column funding_status text not null default 'pending'
    constraint agent_keys_funding_status check (funding_status in ('pending', 'funded', 'failed')),
  add column funding_attempts integer not null default 0
    constraint agent_keys_funding_attempts check (funding_attempts between 0 and 1000),
  add column funding_error text
    constraint agent_keys_funding_error_format check (funding_error ~ '^[A-Z][A-Z_]{0,63}$'),
  add column funded_at timestamptz,
  add constraint agent_keys_funded_at check ((funding_status = 'funded') = (funded_at is not null)),
  -- A funded account has nothing left to report.
  add constraint agent_keys_funded_no_error check (funding_status <> 'funded' or funding_error is null);

create function ujira.agent_key_funding_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.funding_status = 'funded' and (
    new.funding_status is distinct from old.funding_status
    or new.funded_at is distinct from old.funded_at
  ) then
    raise exception using
      errcode = 'UJ004',
      message = 'a funded agent account stays funded';
  end if;
  -- The count is how the retries are bounded, so it only goes up.
  if new.funding_attempts < old.funding_attempts then
    raise exception using
      errcode = 'UJ004',
      message = 'agent key funding attempts never go down';
  end if;
  return new;
end
$fn$;

create trigger agent_keys_funding_guard before update on ujira.agent_keys
  for each row execute function ujira.agent_key_funding_guard();

-- The app funds a key right after making it, and the worker retries. Neither
-- gains any other column, and the secret stays the worker's alone to read.
grant select (funding_status, funding_attempts, funding_error, funded_at)
  on ujira.agent_keys to ujira_app, ujira_reader;
grant update (funding_status, funding_attempts, funding_error, funded_at)
  on ujira.agent_keys to ujira_app, ujira_worker;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop trigger agent_keys_funding_guard on ujira.agent_keys;
drop function ujira.agent_key_funding_guard();
alter table ujira.agent_keys
  drop constraint agent_keys_funded_no_error,
  drop constraint agent_keys_funded_at,
  drop column funded_at,
  drop column funding_error,
  drop column funding_attempts,
  drop column funding_status;

reset role;
