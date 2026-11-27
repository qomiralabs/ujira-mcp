-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Mandates, the per project agent keys named in them, the recipients a mandate
-- pays, their one optional piece of personal data, and where they are paid.
--
-- The chain holds a mandate's rules. These rows hold what the chain cannot:
-- which tenant a contract belongs to, the name people know it by, the key that
-- drives it, and who its recipients are. Limits, balance, committed and free are
-- read from the chain, so there is no second copy here to drift from it.
--
-- Addresses are checked for shape only. Which chain an address belongs to, and
-- its one canonical spelling, are the chain adapter's to decide, and the
-- repositories put every account through it before a row is written: the same
-- wallet spelled two ways would otherwise be two destinations.
--
-- Personal data lives in recipient_pii alone, as ciphertext, so every other row
-- can be kept for as long as the financial record needs without holding any.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- One key per project and network drives that project's mandates, so the chain
-- itself refuses project B's key on project A's mandate even if our code picked
-- the wrong row. The secret is AES-256-GCM ciphertext under a key held outside
-- the database, with the project id as associated data, so a ciphertext moved
-- to another row does not decrypt.
create table ujira.agent_keys (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  network text not null
    constraint agent_keys_network_format check (network ~ '^[a-z][a-z0-9_]{0,31}:[a-z0-9_]{1,32}$'),
  public_key text not null
    constraint agent_keys_public_key_format check (public_key ~ '^[A-Za-z0-9]{1,128}$'),
  -- At least the 16 byte tag and one byte of secret.
  secret_ciphertext bytea not null
    constraint agent_keys_secret_length check (octet_length(secret_ciphertext) between 17 and 1024),
  secret_nonce bytea not null
    constraint agent_keys_nonce_length check (octet_length(secret_nonce) = 12),
  status text not null default 'active'
    constraint agent_keys_status check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Global, because a key that drove two projects' mandates would undo the
  -- isolation it exists for.
  constraint agent_keys_public_key_key unique (network, public_key),
  constraint agent_keys_tenant_key unique (principal_id, project_id, id),
  -- What a mandate points at, so the agent it names is this key, on its network.
  constraint agent_keys_identity_key unique (principal_id, project_id, id, network, public_key),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

-- A retired key stays, because the mandates it was named in still name it.
create unique index agent_keys_one_active
  on ujira.agent_keys (principal_id, project_id, network)
  where status = 'active';

create table ujira.mandates (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint mandates_name_length check (char_length(name) between 1 and 200),
  chain text not null,
  network text not null
    constraint mandates_network_format check (network ~ '^[a-z][a-z0-9_]{0,31}:[a-z0-9_]{1,32}$'),
  contract_address text not null
    constraint mandates_contract_address_format check (contract_address ~ '^[A-Za-z0-9]{1,128}$'),
  -- The token the contract holds and pays, at the only scale that token has on
  -- this chain. Payouts point at these three, so their amounts are always in
  -- the mandate's own unit.
  asset text not null,
  scale ujira.scale not null,
  -- Null only for a mandate made before projects had their own keys, which
  -- names an agent outside this project's keys. agent_address is always what
  -- the chain names as the agent.
  agent_key_id uuid,
  agent_address text not null
    constraint mandates_agent_address_format check (agent_address ~ '^[A-Za-z0-9]{1,128}$'),
  -- The wallet that owns the contract and signs its changes.
  principal_wallet text not null
    constraint mandates_principal_wallet_format check (principal_wallet ~ '^[A-Za-z0-9]{1,128}$'),
  -- Null for an imported mandate whose creating transaction we never saw.
  created_tx_hash ujira.hash32,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mandates_network_on_chain check (split_part(network, ':', 1) = chain),
  -- Global: a contract belongs to one project. It tells a second project that
  -- names the same contract that it is taken, which is the point, and the
  -- import checks on chain that the caller's wallet owns it before it gets here.
  constraint mandates_contract_key unique (network, contract_address),
  constraint mandates_tenant_key unique (principal_id, project_id, id),
  constraint mandates_unit_key unique (principal_id, project_id, id, chain, asset, scale),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  constraint mandates_agent_key
    foreign key (principal_id, project_id, agent_key_id, network, agent_address)
    references ujira.agent_keys (principal_id, project_id, id, network, public_key),
  foreign key (asset, chain, scale)
    references ujira.settlement_tokens (asset, chain, token_scale)
);

-- recipient_ref is the salted hash the chain knows the person by, so the mandate
-- can recognise them again without the chain or this row holding who they are.
-- The label is the name the principal and their agent use for the recipient.
create table ujira.recipients (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null,
  label text not null
    constraint recipients_label_format check (
      char_length(label) between 1 and 100
      and label = btrim(label)
      and label !~ '[[:cntrl:]]'
    ),
  recipient_ref ujira.hash32 not null,
  status text not null default 'active'
    constraint recipients_status check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipients_ref_per_mandate unique (principal_id, project_id, mandate_id, recipient_ref),
  constraint recipients_tenant_key unique (principal_id, project_id, id),
  -- Lets a payout name a recipient and a mandate that belong together, and
  -- serves a mandate's recipient list in key order.
  constraint recipients_mandate_key unique (principal_id, project_id, mandate_id, id),
  foreign key (principal_id, project_id, mandate_id)
    references ujira.mandates (principal_id, project_id, id)
);

-- An agent names a recipient by label, so two that differ only in case would
-- make the name ambiguous.
create unique index recipients_label_per_mandate
  on ujira.recipients (principal_id, project_id, mandate_id, lower(label));

-- The only home of personal data, and it holds ciphertext only, under the same
-- outside key as the agent secrets.
create table ujira.recipient_pii (
  principal_id uuid not null,
  project_id uuid not null,
  recipient_id uuid not null,
  email_ciphertext bytea not null
    constraint recipient_pii_email_length check (octet_length(email_ciphertext) between 17 and 1024),
  email_nonce bytea not null
    constraint recipient_pii_nonce_length check (octet_length(email_nonce) = 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_id, project_id, recipient_id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

-- Where a recipient is paid. Only the wallet method exists. A partner rail adds
-- its method to the check, and any columns it needs, in its own migration,
-- without changing what is here.
--
-- There is no memo column. The wallet rail sends none, so an address whose
-- owner requires one, an exchange deposit address for instance, would take the
-- money and not know whose it is. The repository refuses such an address.
create table ujira.payout_methods (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null,
  method text not null
    constraint payout_methods_method check (method in ('stellar_wallet')),
  destination_address text not null
    constraint payout_methods_destination_format check (destination_address ~ '^[A-Za-z0-9]{1,128}$'),
  -- When the recipient proved they control the destination. Set once.
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payout_methods_destination_per_recipient
    unique (principal_id, project_id, recipient_id, method, destination_address),
  constraint payout_methods_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

-- A proof, once recorded, is a fact about the past: moving or clearing it would
-- let an unproven destination pass as a proven one.
create function ujira.keep_payout_method_verified() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception using
      errcode = 'UJ006',
      message = 'a payout method stays verified at the time it was first verified';
  end if;
  return new;
end
$fn$;

create trigger payout_methods_keep_verified before update on ujira.payout_methods
  for each row execute function ujira.keep_payout_method_verified();

insert into ujira.status_transitions (machine, from_status, to_status) values
  ('agent_key', 'active', 'retired'),
  ('recipient', 'active', 'suspended'),
  ('recipient', 'suspended', 'active');

create trigger agent_keys_status before update on ujira.agent_keys
  for each row execute function ujira.check_transition('agent_key');
create trigger recipients_status before update on ujira.recipients
  for each row execute function ujira.check_transition('recipient');

create trigger agent_keys_touch before update on ujira.agent_keys
  for each row execute function ujira.touch();
create trigger mandates_touch before update on ujira.mandates
  for each row execute function ujira.touch();
create trigger recipients_touch before update on ujira.recipients
  for each row execute function ujira.touch();
create trigger recipient_pii_touch before update on ujira.recipient_pii
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.agent_keys');
select ujira.apply_tenant_policies('ujira.mandates');
select ujira.apply_tenant_policies('ujira.recipients');
select ujira.apply_tenant_policies('ujira.recipient_pii');
select ujira.apply_tenant_policies('ujira.payout_methods');

-- Column grants throughout, so what identifies a row (its tenant, its contract,
-- its key, its destination) can never be rewritten by the app, only what is
-- meant to change.
--
-- The app makes agent keys but never reads a secret back: only the worker signs,
-- so only the worker can read one. The reader serves dashboards and gets neither
-- the secrets nor the personal data.
grant insert on ujira.agent_keys to ujira_app;
grant select (principal_id, project_id, id, network, public_key, status, created_at, updated_at)
  on ujira.agent_keys to ujira_app, ujira_reader;
grant update (status) on ujira.agent_keys to ujira_app;
grant select on ujira.agent_keys to ujira_worker;

grant select, insert on ujira.mandates to ujira_app;
grant update (name) on ujira.mandates to ujira_app;
grant select on ujira.mandates to ujira_worker, ujira_reader;

grant select, insert on ujira.recipients to ujira_app;
grant update (label, status) on ujira.recipients to ujira_app;
grant select on ujira.recipients to ujira_worker, ujira_reader;

grant select, insert on ujira.recipient_pii to ujira_app;
grant update (email_ciphertext, email_nonce) on ujira.recipient_pii to ujira_app;

grant select, insert on ujira.payout_methods to ujira_app;
grant update (verified_at) on ujira.payout_methods to ujira_app;
grant select on ujira.payout_methods to ujira_worker, ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.payout_methods;
drop function ujira.keep_payout_method_verified();
drop table ujira.recipient_pii;
drop table ujira.recipients;
drop table ujira.mandates;
drop table ujira.agent_keys;
delete from ujira.status_transitions where machine in ('agent_key', 'recipient');

reset role;
