-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- When a token was last used, and the one call that spends rate limit tokens.
--
-- The app role still cannot read the buckets. It reaches them only through this
-- function, which runs as ujira_fn_rate_limits, so one call per request is one
-- round trip whatever the number of buckets.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.api_tokens add column last_used_at timestamptz;

-- Refills each bucket, then takes one token from each if every one has a token
-- to give, and from none otherwise. All or none, so a token past its own limit
-- does not drain its principal's bucket and starve the principal's other tokens.
--
-- Buckets are locked in key order, so two requests sharing buckets queue rather
-- than deadlock. The clock is read after the lock, and elapsed time never goes
-- below zero, so a request that waited in that queue cannot refill twice.
create function ujira.take_rate_limit_tokens(
  bucket_keys text[],
  capacities integer[],
  refills_per_second integer[]
) returns table (taken_key text, allowed boolean, remaining numeric)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  all_allowed boolean := true;
  available numeric;
  wanted record;
begin
  if coalesce(cardinality(bucket_keys), 0) not between 1 and 8
     or cardinality(capacities) is distinct from cardinality(bucket_keys)
     or cardinality(refills_per_second) is distinct from cardinality(bucket_keys) then
    raise exception using
      errcode = '22023',
      message = 'from 1 to 8 buckets, each with a capacity and a refill rate';
  end if;
  for wanted in
    select u.key_text, u.capacity, u.refill
      from unnest(bucket_keys, capacities, refills_per_second) as u (key_text, capacity, refill)
     order by u.key_text
  loop
    if wanted.capacity is null or wanted.capacity < 1
       or wanted.refill is null or wanted.refill < 1 then
      raise exception using
        errcode = '22023',
        message = 'a bucket holds at least 1 token and refills at least 1 per second';
    end if;
    insert into ujira.rate_limit_buckets as b (bucket_key, tokens, refilled_at)
      values (wanted.key_text, wanted.capacity, clock_timestamp())
      on conflict (bucket_key) do update
        set tokens = least(
              wanted.capacity,
              b.tokens
                + greatest(extract(epoch from clock_timestamp() - b.refilled_at), 0) * wanted.refill
            ),
            refilled_at = greatest(clock_timestamp(), b.refilled_at)
      returning b.tokens into available;
    all_allowed := all_allowed and available >= 1;
  end loop;
  if all_allowed then
    update ujira.rate_limit_buckets as b
       set tokens = b.tokens - 1
     where b.bucket_key = any (bucket_keys);
  end if;
  return query
    select b.bucket_key, all_allowed, b.tokens
      from ujira.rate_limit_buckets as b
     where b.bucket_key = any (bucket_keys);
end
$fn$;

revoke all on function ujira.take_rate_limit_tokens(text[], integer[], integer[]) from public;
grant execute on function ujira.take_rate_limit_tokens(text[], integer[], integer[]) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_rate_limits;
alter function ujira.take_rate_limit_tokens(text[], integer[], integer[])
  owner to ujira_fn_rate_limits;
revoke create on schema ujira from ujira_fn_rate_limits;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.take_rate_limit_tokens(text[], integer[], integer[]);
alter table ujira.api_tokens drop column last_used_at;

reset role;
