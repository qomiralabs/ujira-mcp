-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- What the fee sponsor has paid, or may yet pay, for each principal on each
-- day. Principals never hold XLM: every transaction they sign through UJIRA is
-- wrapped in a fee bump that the sponsor pays, and the daily cap per principal
-- is what keeps one principal from spending the sponsor's balance for everyone.
--
-- A sponsorship is reserved at the bump's maximum fee before anything is sent,
-- then settled at what the network charged, or released when the network never
-- took the transaction. The row is keyed by the hash of the principal signed
-- transaction, so retrying one envelope never counts it twice.
--
-- The cap is per principal across all of its projects, so the running total
-- sits in a per principal day row, the way an audit head does. Its lock puts
-- every reservation of one principal on one day in order, whichever project it
-- comes from, so two racing requests cannot both slip under the cap.
--
-- Fees are the network's own fee unit, stroops, which the network itself keeps
-- as a signed 64 bit integer. They are not principal money and carry no asset,
-- so they are bigint here rather than an amount column.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.fee_sponsor_days (
  principal_id uuid not null references ujira.principals (id),
  -- The UTC day the sponsored transactions were reserved on.
  day date not null,
  -- Settled charges plus the maximum of every reservation still open.
  used_stroops bigint not null default 0
    constraint fee_sponsor_days_used_not_negative check (used_stroops >= 0),
  primary key (principal_id, day)
);

create table ujira.fee_sponsorships (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  inner_tx_hash ujira.hash32 not null,
  day date not null,
  max_fee_stroops bigint not null
    constraint fee_sponsorships_max_fee_positive check (max_fee_stroops > 0),
  charged_stroops bigint,
  status text not null default 'reserved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A reservation has no charge yet, a settled one has what the network took,
  -- up to the maximum, and a released one cost nothing.
  constraint fee_sponsorships_status_charge check (
    (status = 'reserved' and charged_stroops is null)
    or (status = 'settled' and charged_stroops between 0 and max_fee_stroops)
    or (status = 'released' and charged_stroops = 0)
  ),
  constraint fee_sponsorships_tenant_tx unique (principal_id, project_id, inner_tx_hash),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id),
  foreign key (principal_id, day) references ujira.fee_sponsor_days (principal_id, day)
);

-- A released envelope may be sent again, as long as it is still valid, so it
-- can be reserved again. A settled one has been paid for and stays settled.
insert into ujira.status_transitions (machine, from_status, to_status) values
  ('fee_sponsorship', 'reserved', 'settled'),
  ('fee_sponsorship', 'reserved', 'released'),
  ('fee_sponsorship', 'released', 'reserved');

create trigger fee_sponsorships_status before update on ujira.fee_sponsorships
  for each row execute function ujira.check_transition('fee_sponsorship');
create trigger fee_sponsorships_touch before update on ujira.fee_sponsorships
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.fee_sponsorships');

-- A day row belongs to the whole principal, so the policies name the principal
-- alone. Writing one still needs a project in context: the read only scope that
-- spans every project sets none, and so can only read.
alter table ujira.fee_sponsor_days enable row level security;
alter table ujira.fee_sponsor_days force row level security;
create policy tenant_read on ujira.fee_sponsor_days for select to ujira_app, ujira_reader
  using (principal_id = ujira.current_principal_id());
create policy tenant_insert on ujira.fee_sponsor_days for insert to ujira_app
  with check (
    principal_id = ujira.current_principal_id() and ujira.current_project_id() is not null
  );
create policy tenant_update on ujira.fee_sponsor_days for update to ujira_app
  using (principal_id = ujira.current_principal_id())
  with check (
    principal_id = ujira.current_principal_id() and ujira.current_project_id() is not null
  );
create policy owner_all on ujira.fee_sponsor_days for all to ujira_owner
  using (true) with check (true);

-- Column grants, so the app can move a reservation along and the day's total,
-- and never rewrite whose it is or which transaction it covers. Submitting a
-- signed transaction is a web request, so the worker gets nothing.
grant select, insert on ujira.fee_sponsor_days to ujira_app;
grant update (used_stroops) on ujira.fee_sponsor_days to ujira_app;
grant select on ujira.fee_sponsor_days to ujira_reader;

grant select, insert on ujira.fee_sponsorships to ujira_app;
grant update (status, day, max_fee_stroops, charged_stroops) on ujira.fee_sponsorships to ujira_app;
grant select on ujira.fee_sponsorships to ujira_reader;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop table ujira.fee_sponsorships;
drop table ujira.fee_sponsor_days;
delete from ujira.status_transitions where machine = 'fee_sponsorship';

reset role;
