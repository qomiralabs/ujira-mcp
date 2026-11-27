-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Payouts, the legs they pay out in, and the receipt each finished payout gets.
--
-- A payout is the record an agent or a person asks for: this much, to this
-- recipient, on this mandate, for this task. It is written before anything is
-- sent on chain, so no transaction ever leaves for a payout the database does
-- not hold. Three unique keys stop it being paid twice: the request's
-- idempotency key, the task on its mandate, and the payout id the contract
-- knows it by.
--
-- Every payout is one or more legs from the start, and its legs add up to its
-- total exactly, checked at commit, so a payout and its legs are written in
-- one transaction in either order and can never be seen apart.
--
-- Status moves are rows of ujira.status_transitions, the same table the code
-- keeps, and a trigger refuses any other move. A payout that has finished is
-- not changed again, and its receipt copies it rather than restating it, so
-- the two cannot disagree.
--
-- The fee columns exist from the start so a fee stack arrives as an additive
-- change. Testnet takes no fee, and the database says so.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- What a payout's and a leg's foreign keys point at, so a payout is always in
-- its mandate's network and unit, and a leg pays only a destination of the
-- payout's own recipient, exactly as that destination was recorded.
alter table ujira.mandates
  add constraint mandates_payout_unit_key
    unique (principal_id, project_id, id, network, chain, asset, scale);
alter table ujira.payout_methods
  add constraint payout_methods_leg_key
    unique (principal_id, project_id, recipient_id, id, method, destination_address);

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('payout', 'queued', 'submitting'),
  ('payout', 'queued', 'blocked'),
  ('payout', 'queued', 'failed'),
  ('payout', 'submitting', 'pending_approval'),
  ('payout', 'submitting', 'approved'),
  ('payout', 'submitting', 'blocked'),
  ('payout', 'submitting', 'needs_attention'),
  ('payout', 'pending_approval', 'approved'),
  ('payout', 'pending_approval', 'rejected'),
  ('payout', 'pending_approval', 'cancelled'),
  ('payout', 'approved', 'settling'),
  ('payout', 'settling', 'paid'),
  ('payout', 'settling', 'needs_attention'),
  ('payout', 'needs_attention', 'submitting'),
  ('payout', 'needs_attention', 'settling'),
  ('payout', 'needs_attention', 'paid'),
  ('payout', 'needs_attention', 'failed'),
  -- A leg is planned until its transfer is sent. A send the chain refused goes
  -- back to planned to be sent again; reconcile may find a transfer landed that
  -- was never recorded as sent, so planned may move straight to settled.
  ('payout_leg', 'planned', 'submitted'),
  ('payout_leg', 'planned', 'settled'),
  ('payout_leg', 'planned', 'failed'),
  ('payout_leg', 'planned', 'cancelled'),
  ('payout_leg', 'submitted', 'settled'),
  ('payout_leg', 'submitted', 'planned'),
  ('payout_leg', 'submitted', 'failed');

create table ujira.payouts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- The key the request came with, in the same form the HTTP layer accepts.
  idempotency_key text not null
    constraint payouts_idempotency_key_format check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  -- What the first request asked for, so a retry is told apart from the same
  -- key reused for a different payout.
  request_hash ujira.hash32 not null,
  mandate_id uuid not null,
  recipient_id uuid not null,
  task_id text not null
    constraint payouts_task_id_format check (task_id ~ '^[A-Za-z0-9._:/@#-]{1,128}$'),
  -- Derived from the mandate and the task, and refused twice by the contract.
  onchain_payout_id ujira.hash32 not null,
  network text not null
    constraint payouts_network_format check (network ~ '^[a-z][a-z0-9_]{0,31}:[a-z0-9_]{1,32}$'),
  chain text not null,
  amount ujira.amount not null
    constraint payouts_amount_positive check (amount > 0),
  fee_amount ujira.amount not null default 0
    constraint payouts_fee_not_negative check (fee_amount >= 0),
  asset text not null,
  scale ujira.scale not null,
  -- The caller's own labels, never shown to the recipient. The bounds on keys
  -- and values are checked by payout_before_insert, as a check cannot count.
  metadata jsonb not null default '{}'
    constraint payouts_metadata_object check (jsonb_typeof(metadata) = 'object'),
  status text not null default 'queued'
    constraint payouts_status check (
      status in (
        'queued',
        'submitting',
        'pending_approval',
        'approved',
        'settling',
        'paid',
        'partly_paid',
        'needs_attention',
        'blocked',
        'rejected',
        'cancelled',
        'failed'
      )
    ),
  -- The spec error the mandate or the router refused it with.
  blocked_by text
    constraint payouts_blocked_by_format check (blocked_by ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  request_tx_hash ujira.hash32,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stamped by payout_guard when the payout reaches paid.
  settled_at timestamptz,
  constraint payouts_network_on_chain check (split_part(network, ':', 1) = chain),
  constraint payouts_blocked_has_reason check ((status = 'blocked') = (blocked_by is not null)),
  constraint payouts_settled_when_paid check ((status = 'paid') = (settled_at is not null)),
  constraint payouts_testnet_fee_free check (network <> 'stellar:testnet' or fee_amount = 0),
  constraint payouts_idempotency unique (principal_id, project_id, idempotency_key),
  constraint payouts_task unique (principal_id, project_id, mandate_id, task_id),
  constraint payouts_onchain_id unique (mandate_id, onchain_payout_id),
  constraint payouts_tenant_key unique (principal_id, project_id, id),
  -- What a leg's foreign key needs.
  constraint payouts_leg_key
    unique (principal_id, project_id, id, recipient_id, network, chain, asset, scale),
  constraint payouts_mandate
    foreign key (principal_id, project_id, mandate_id, network, chain, asset, scale)
    references ujira.mandates (principal_id, project_id, id, network, chain, asset, scale),
  -- The recipient must be one of this mandate's.
  constraint payouts_recipient
    foreign key (principal_id, project_id, mandate_id, recipient_id)
    references ujira.recipients (principal_id, project_id, mandate_id, id)
);

-- Lists are newest first, by project, and filtered by one of these.
create index payouts_by_created
  on ujira.payouts (principal_id, project_id, created_at desc, id desc);
create index payouts_by_status
  on ujira.payouts (principal_id, project_id, status, created_at desc, id desc);
create index payouts_by_mandate
  on ujira.payouts (principal_id, project_id, mandate_id, created_at desc, id desc);
create index payouts_by_recipient
  on ujira.payouts (principal_id, project_id, recipient_id, created_at desc, id desc);

create table ujira.payout_legs (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  recipient_id uuid not null,
  -- Up to four legs; leg 0 carries any rounding remainder.
  leg_index smallint not null
    constraint payout_legs_index_range check (leg_index between 0 and 3),
  payout_method_id uuid not null,
  method text not null,
  destination_address text not null,
  network text not null,
  chain text not null,
  asset text not null,
  scale ujira.scale not null,
  amount ujira.amount not null
    constraint payout_legs_amount_positive check (amount > 0),
  fee_amount ujira.amount not null default 0
    constraint payout_legs_fee_not_negative check (fee_amount >= 0),
  -- Written by payout_leg_stamp from the payout and the index, so a retried
  -- leg can never carry another key.
  leg_key ujira.hash32 not null,
  chain_tx_hash ujira.hash32,
  status text not null default 'planned'
    constraint payout_legs_status check (
      status in ('planned', 'submitted', 'settled', 'failed', 'cancelled')
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_legs_testnet_fee_free check (network <> 'stellar:testnet' or fee_amount = 0),
  constraint payout_legs_sent_has_tx
    check (status not in ('submitted', 'settled') or chain_tx_hash is not null),
  constraint payout_legs_index unique (payout_id, leg_index),
  constraint payout_legs_leg_key unique (leg_key),
  constraint payout_legs_tenant_key unique (principal_id, project_id, id),
  constraint payout_legs_payout
    foreign key (principal_id, project_id, payout_id, recipient_id, network, chain, asset, scale)
    references ujira.payouts (principal_id, project_id, id, recipient_id, network, chain, asset, scale),
  constraint payout_legs_method
    foreign key (principal_id, project_id, recipient_id, payout_method_id, method, destination_address)
    references ujira.payout_methods (principal_id, project_id, recipient_id, id, method, destination_address)
);

create index payout_legs_by_method on ujira.payout_legs (principal_id, project_id, payout_method_id);

-- One per payout, written once it has finished. It copies the payout's
-- outcome and money, stamped by receipt_stamp, so a caller names only the
-- payout and the chain reference.
create table ujira.receipts (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null,
  status text not null
    constraint receipts_status check (status in ('paid', 'blocked', 'rejected', 'cancelled', 'failed')),
  blocked_by text,
  network text not null,
  chain text not null,
  amount ujira.amount not null,
  fee_amount ujira.amount not null,
  asset text not null,
  scale ujira.scale not null,
  -- The adapter's reference to the transfer, opaque here.
  chain_receipt_ref text
    constraint receipts_chain_ref_format check (chain_receipt_ref ~ '^[A-Za-z0-9:._-]{1,512}$'),
  request_tx_hash ujira.hash32,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint receipts_paid_has_ref check (status <> 'paid' or chain_receipt_ref is not null),
  constraint receipts_payout unique (payout_id),
  constraint receipts_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, payout_id)
    references ujira.payouts (principal_id, project_id, id)
);

create index receipts_by_created
  on ujira.receipts (principal_id, project_id, created_at desc, id desc);

-- Counts and lengths a check constraint cannot express.
create function ujira.payout_before_insert() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  entry record;
  keys integer := 0;
begin
  -- Anything but an object is left for payouts_metadata_object to refuse,
  -- since jsonb_each would fail on it with a less useful error.
  if jsonb_typeof(new.metadata) is distinct from 'object' then
    return new;
  end if;
  for entry in select * from jsonb_each(new.metadata) loop
    keys := keys + 1;
    if keys > 16
       or char_length(entry.key) not between 1 and 256
       or jsonb_typeof(entry.value) <> 'string'
       or char_length(entry.value #>> '{}') > 256 then
      raise exception using
        errcode = 'UJ009',
        message = 'payout metadata holds at most 16 keys, each a string of at most 256 characters';
    end if;
  end loop;
  return new;
end
$fn$;

-- A finished payout is a fact about the past and is not changed, and the
-- request transaction is recorded once. Reaching paid stamps the time.
create function ujira.payout_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.status in ('paid', 'blocked', 'rejected', 'cancelled', 'failed') then
    raise exception using
      errcode = 'UJ007',
      message = format('a payout that is %s has finished and is not changed', old.status);
  end if;
  if old.request_tx_hash is not null
     and new.request_tx_hash is distinct from old.request_tx_hash then
    raise exception using
      errcode = 'UJ006',
      message = 'a payout keeps the request transaction it first recorded';
  end if;
  if new.status = 'paid' then
    new.settled_at := now();
  end if;
  return new;
end
$fn$;

-- The argument names the column that holds the payout id on the firing table.
-- Runs at commit, so it sees the payout and all of its legs together.
create function ujira.payout_legs_add_up() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  target uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
  total numeric;
  fee numeric;
  legs bigint;
  paid numeric;
  fees numeric;
begin
  select p.amount, p.fee_amount into total, fee
    from ujira.payouts as p
   where p.principal_id = new.principal_id
     and p.project_id = new.project_id
     and p.id = target;
  select count(*), coalesce(sum(l.amount), 0), coalesce(sum(l.fee_amount), 0)
    into legs, paid, fees
    from ujira.payout_legs as l
   where l.principal_id = new.principal_id
     and l.project_id = new.project_id
     and l.payout_id = target;
  if legs = 0 or paid is distinct from total or fees is distinct from fee then
    raise exception using
      errcode = 'UJ005',
      message = format(
        'the %s legs of a payout pay %s and charge %s; the payout is %s with a fee of %s',
        legs, paid, fees, total, fee
      );
  end if;
  return null;
end
$fn$;

-- The key is what the rail sends a leg under, so it comes from the payout and
-- the index alone and never from a caller.
create function ujira.payout_leg_stamp() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  new.leg_key := sha256(
    convert_to('ujira/leg/v1|' || new.payout_id::text || '|' || new.leg_index::text, 'UTF8')
  );
  return new;
end
$fn$;

-- Copies the payout into its receipt, and refuses a receipt for a payout that
-- has not finished, or that this transaction cannot see.
create function ujira.receipt_stamp() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
declare
  payout record;
begin
  select p.status, p.blocked_by, p.network, p.chain, p.amount, p.fee_amount, p.asset, p.scale,
         p.request_tx_hash, p.settled_at
    into payout
    from ujira.payouts as p
   where p.principal_id = new.principal_id
     and p.project_id = new.project_id
     and p.id = new.payout_id;
  -- Two checks, because a record that found no row has no fields to read.
  if not found then
    raise exception using
      errcode = 'UJ008',
      message = 'a receipt is written only for a finished payout of this project';
  end if;
  if payout.status not in ('paid', 'blocked', 'rejected', 'cancelled', 'failed') then
    raise exception using
      errcode = 'UJ008',
      message = 'a receipt is written only for a finished payout of this project';
  end if;
  new.status := payout.status;
  new.blocked_by := payout.blocked_by;
  new.network := payout.network;
  new.chain := payout.chain;
  new.amount := payout.amount;
  new.fee_amount := payout.fee_amount;
  new.asset := payout.asset;
  new.scale := payout.scale;
  new.request_tx_hash := payout.request_tx_hash;
  new.settled_at := payout.settled_at;
  return new;
end
$fn$;

create trigger payouts_before_insert before insert on ujira.payouts
  for each row execute function ujira.payout_before_insert();
create trigger payouts_guard before update on ujira.payouts
  for each row execute function ujira.payout_guard();
create trigger payouts_status before update on ujira.payouts
  for each row execute function ujira.check_transition('payout');
create trigger payouts_touch before update on ujira.payouts
  for each row execute function ujira.touch();
create constraint trigger payouts_legs_add_up after insert or update of amount, fee_amount
  on ujira.payouts
  deferrable initially deferred
  for each row execute function ujira.payout_legs_add_up('id');
create trigger payouts_no_delete before delete on ujira.payouts
  for each row execute function ujira.forbid_mutation();
create trigger payouts_no_truncate before truncate on ujira.payouts
  for each statement execute function ujira.forbid_mutation();

create trigger payout_legs_stamp before insert or update of payout_id, leg_index
  on ujira.payout_legs
  for each row execute function ujira.payout_leg_stamp();
create trigger payout_legs_status before update on ujira.payout_legs
  for each row execute function ujira.check_transition('payout_leg');
create trigger payout_legs_touch before update on ujira.payout_legs
  for each row execute function ujira.touch();
create constraint trigger payout_legs_add_up after insert or update of amount, fee_amount, payout_id
  on ujira.payout_legs
  deferrable initially deferred
  for each row execute function ujira.payout_legs_add_up('payout_id');
create trigger payout_legs_no_delete before delete on ujira.payout_legs
  for each row execute function ujira.forbid_mutation();
create trigger payout_legs_no_truncate before truncate on ujira.payout_legs
  for each statement execute function ujira.forbid_mutation();

create trigger receipts_stamp before insert on ujira.receipts
  for each row execute function ujira.receipt_stamp();
create trigger receipts_append_only before update or delete on ujira.receipts
  for each row execute function ujira.forbid_mutation();
create trigger receipts_no_truncate before truncate on ujira.receipts
  for each statement execute function ujira.forbid_mutation();

select ujira.apply_tenant_policies('ujira.payouts');
select ujira.apply_tenant_policies('ujira.payout_legs');
select ujira.apply_tenant_policies('ujira.receipts');

-- Insert grants name their columns, so a new payout always starts queued with
-- nothing recorded, a new leg starts planned with its key derived, and a
-- receipt names only its payout and the chain reference. Update grants name
-- what moves: the status and what is recorded with it.
grant select on ujira.payouts, ujira.payout_legs, ujira.receipts
  to ujira_app, ujira_worker, ujira_reader;

grant insert (
  principal_id, project_id, idempotency_key, request_hash, mandate_id, recipient_id, task_id,
  onchain_payout_id, network, chain, amount, fee_amount, asset, scale, metadata
) on ujira.payouts to ujira_app;
grant update (status, blocked_by, request_tx_hash) on ujira.payouts to ujira_app, ujira_worker;

grant insert (
  principal_id, project_id, payout_id, recipient_id, leg_index, payout_method_id, method,
  destination_address, network, chain, asset, scale, amount, fee_amount
) on ujira.payout_legs to ujira_app;
grant update (status, chain_tx_hash) on ujira.payout_legs to ujira_app, ujira_worker;

grant insert (principal_id, project_id, payout_id, chain_receipt_ref)
  on ujira.receipts to ujira_worker;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.receipts;
drop table ujira.payout_legs;
drop table ujira.payouts;
drop function ujira.receipt_stamp();
drop function ujira.payout_leg_stamp();
drop function ujira.payout_legs_add_up();
drop function ujira.payout_guard();
drop function ujira.payout_before_insert();
delete from ujira.status_transitions where machine in ('payout', 'payout_leg');
alter table ujira.payout_methods drop constraint payout_methods_leg_key;
alter table ujira.mandates drop constraint mandates_payout_unit_key;

reset role;
