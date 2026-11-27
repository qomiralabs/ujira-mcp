-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- What the chain last said about a payout destination, and the transactions
-- UJIRA prepared for a principal's wallet to sign.
--
-- A destination with no account or no trustline is kept, because its owner
-- can fix that, but it must not be paid until they do. The answer is stored
-- with the destination so every list and every payout sees the same reason,
-- without a chain call per row. The payout path checks again before it asks
-- the chain for money, so a stale answer can block a payout but never let a
-- bad one through.
--
-- A signing request is kept from the moment it is prepared until its signed
-- envelope comes back, so the envelope can be compared with exactly what was
-- prepared, under the tenant that asked for it. Nothing in it is secret: an
-- unsigned envelope and the account that has to sign it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- unchecked is only for rows written before this column; every new
-- destination is checked before it is stored.
alter table ujira.payout_methods
  add column destination_status text not null default 'unchecked'
    constraint payout_methods_destination_status
      check (destination_status in ('unchecked', 'receivable', 'no_account', 'no_trustline')),
  add column destination_checked_at timestamptz,
  add constraint payout_methods_destination_checked
    check ((destination_status = 'unchecked') = (destination_checked_at is null));

create table ujira.signing_requests (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- Null while the request creates the mandate it is for.
  mandate_id uuid,
  action text not null
    constraint signing_requests_action check (
      action in (
        'create', 'fund', 'allow_recipients', 'pause', 'resume', 'revoke',
        'approve', 'reject', 'withdraw'
      )
    ),
  network text not null
    constraint signing_requests_network_format check (network ~ '^[a-z][a-z0-9_]{0,31}:[a-z0-9_]{1,32}$'),
  signer text not null
    constraint signing_requests_signer_format check (signer ~ '^[A-Za-z0-9]{1,128}$'),
  -- Base64, bounded well inside the 64 KB request limit a signed copy has to fit in.
  envelope text not null
    constraint signing_requests_envelope_format check (
      char_length(envelope) between 4 and 32768 and envelope ~ '^[A-Za-z0-9+/]+={0,2}$'
    ),
  summary text not null
    constraint signing_requests_summary_length check (char_length(summary) between 1 and 2000),
  expires_at timestamptz not null,
  submitted_tx_hash ujira.hash32,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signing_requests_create_has_no_mandate check ((action = 'create') = (mandate_id is null)),
  constraint signing_requests_submitted_together
    check ((submitted_tx_hash is null) = (submitted_at is null)),
  constraint signing_requests_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id)
);

-- A request is answered once. Recording a second transaction against it would
-- hide which one the chain actually took.
create function ujira.keep_signing_request_submitted() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.submitted_tx_hash is not null
     and (new.submitted_tx_hash is distinct from old.submitted_tx_hash
          or new.submitted_at is distinct from old.submitted_at) then
    raise exception using
      errcode = 'UJ006',
      message = 'a signing request keeps the first transaction submitted for it';
  end if;
  return new;
end
$fn$;

create trigger signing_requests_keep_submitted before update on ujira.signing_requests
  for each row execute function ujira.keep_signing_request_submitted();
create trigger signing_requests_touch before update on ujira.signing_requests
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.signing_requests');

grant update (destination_status, destination_checked_at) on ujira.payout_methods to ujira_app;

grant select, insert on ujira.signing_requests to ujira_app;
grant update (submitted_tx_hash, submitted_at) on ujira.signing_requests to ujira_app;
grant select on ujira.signing_requests to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.signing_requests;
drop function ujira.keep_signing_request_submitted();
alter table ujira.payout_methods
  drop constraint payout_methods_destination_checked,
  drop column destination_checked_at,
  drop column destination_status;

reset role;
