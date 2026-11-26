-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The amount domain and the reference data every money column points at.
-- Money in the database follows the same rules as in code: an integer count
-- of minor units inside the signed 128-bit range Soroban stores, always
-- next to the currency or the asset and chain it is counted in, and at a
-- scale that pair allows. The reference rows are copied from the currency
-- and token tables of the money module, and must be kept equal to them.
--
-- It runs under the bootstrap login because it creates the schema.
--
-- How a money column uses this:
--   fiat:  amount ujira.amount, currency text, scale ujira.scale,
--          foreign key (currency, scale) references ujira.currency_scales
--   token: amount ujira.amount, asset text, chain text, scale ujira.scale,
--          foreign key (asset, chain, scale)
--            references ujira.settlement_tokens (asset, chain, token_scale)
-- so USDC on stellar at any scale but 7 is refused by the database itself.
--
-- The domains carry their constraints, although changing one later
-- revalidates every column of that type. The constraints here are the
-- definition of an amount, a scale and a hash, not something expected to
-- change, and repeating them on every money column is how they would drift.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema ujira;

-- Plain numeric with no type modifier: numeric(39, 0) would round 1.5 to 2
-- on the way in rather than refuse it. scale() also refuses 2.0, which is
-- not how an integer count is written. NaN and both infinities sort outside
-- every finite number, so the range test refuses them; scale() alone would
-- not, because it returns null for them.
create domain ujira.amount as numeric
  constraint amount_is_i128_integer check (
    value between -170141183460469231731687303715884105728
      and 170141183460469231731687303715884105727
    and scale(value) = 0
  );

-- The number of decimal places an amount is counted at. 18 is the finest
-- the money model allows.
create domain ujira.scale as smallint
  constraint scale_in_range check (value between 0 and 18);

-- A SHA-256 digest or a 32 byte chain hash, never hex text.
create domain ujira.hash32 as bytea
  constraint hash32_is_32_bytes check (octet_length(value) = 32);

create table ujira.chains (
  code text primary key
    constraint chains_code_format check (code ~ '^[a-z][a-z0-9_]{0,31}$')
);

-- ISO 4217 fiat currencies and the minor units they are shown and quoted at.
create table ujira.currencies (
  code text primary key
    constraint currencies_code_format check (code ~ '^[A-Z]{3}$'),
  minor_units ujira.scale not null
);

-- Every scale a fiat amount may be held at: its minor units, or finer for
-- rates, caps and conversions, never coarser.
create table ujira.currency_scales (
  currency text not null references ujira.currencies (code),
  scale ujira.scale not null,
  primary key (currency, scale)
);

-- Keyed by asset and chain together, because one asset can carry different
-- decimals on different chains. token_scale is the only scale a token
-- amount is ever held at; display_scale is for people and never for money.
create table ujira.settlement_tokens (
  asset text not null
    constraint settlement_tokens_asset_format check (asset ~ '^[A-Z][A-Z0-9]{1,11}$'),
  chain text not null references ujira.chains (code),
  token_scale ujira.scale not null,
  display_scale ujira.scale not null,
  primary key (asset, chain),
  constraint settlement_tokens_scale_key unique (asset, chain, token_scale)
);

-- The allowed moves of every status machine, one row per move. A table's
-- status trigger reads this, so a machine's rules live in one place and a
-- change to them is a migration anyone can review. Each machine adds its
-- rows in the migration that creates its table.
create table ujira.status_transitions (
  machine text not null
    constraint status_transitions_machine_format check (machine ~ '^[a-z][a-z0-9_]*$'),
  from_status text not null,
  to_status text not null,
  primary key (machine, from_status, to_status)
);

insert into ujira.chains (code) values ('stellar');

insert into ujira.currencies (code, minor_units) values
  ('USD', 2),
  ('NGN', 2),
  ('KES', 2),
  ('GHS', 2),
  ('ZAR', 2),
  ('PHP', 2),
  ('INR', 2),
  ('BRL', 2),
  ('COP', 2),
  ('MXN', 2),
  ('EUR', 2),
  ('GBP', 2);

insert into ujira.currency_scales (currency, scale)
select c.code, s.scale
  from ujira.currencies as c
  cross join lateral generate_series(c.minor_units, 18) as s (scale);

insert into ujira.settlement_tokens (asset, chain, token_scale, display_scale) values
  ('USDC', 'stellar', 7, 2);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop table ujira.status_transitions;
drop table ujira.settlement_tokens;
drop table ujira.currency_scales;
drop table ujira.currencies;
drop table ujira.chains;
drop domain ujira.hash32;
drop domain ujira.scale;
drop domain ujira.amount;
drop schema ujira;
