-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The operations schema, and in it the security events: failed sign-ins, bad
-- tokens and forged callbacks. These often arrive without a tenant anyone can
-- trust, which is why they sit in ops and not in the audit log, and they still
-- need recording.
--
-- ops holds no tenant data, so it is the one explicit exception to tenant
-- columns on every row, and it lives apart from ujira with its own role. An
-- email or an address only ever arrives as an HMAC the caller computed: the
-- same person shows up as the same value, and the table cannot be read back
-- into who they are. Each column's check refuses anything that is not that
-- shape. A token prefix is the public part of a key.
--
-- No service role can read or write the table. Events are written and pruned
-- only through the functions below, which run as ujira_ops.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section. It owns functions and never logs in.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_ops') then
    create role ujira_ops nologin noinherit nobypassrls;
  end if;
  -- Only when it needs it: Postgres 16 and later refuse any change to the
  -- attribute, even taking it away, from a login that does not hold it.
  if exists (
    select from pg_catalog.pg_roles where rolname = 'ujira_ops' and rolbypassrls
  ) then
    alter role ujira_ops nobypassrls;
  end if;
end
$roles$;

-- The owner hands the functions to this role, which needs the owner to be
-- able to act as it.
grant ujira_ops to ujira_owner;

-- Creating a schema needs CREATE on the database, which the owner role does not
-- hold, so it is created for the owner rather than by it.
create schema ops authorization ujira_owner;

set local role ujira_owner;

revoke all on schema ops from public;
grant usage on schema ops to ujira_ops, ujira_app, ujira_retention;

create table ops.security_events (
  id bigint generated always as identity primary key,
  kind text not null
    constraint security_events_kind_known check (
      kind in (
        'sign_in_failed',
        'otp_failed',
        'mfa_failed',
        'token_invalid',
        'token_env_mismatch',
        'csrf_failed',
        'callback_signature_invalid',
        'unresolved_identity_event'
      )
    ),
  email_hmac bytea
    constraint security_events_email_hmac_length check (octet_length(email_hmac) = 32),
  token_prefix text
    constraint security_events_token_prefix_format check (token_prefix ~ '^[A-Za-z0-9_]{8,40}$'),
  ip_hmac bytea
    constraint security_events_ip_hmac_length check (octet_length(ip_hmac) = 32),
  occurred_at timestamptz not null default now()
);

create index security_events_occurred_at on ops.security_events (occurred_at);

create trigger security_events_append_only before update on ops.security_events
  for each row execute function ujira.forbid_mutation();

grant select, insert, delete on ops.security_events to ujira_ops;

-- The time comes from the server, so a caller cannot date an event.
create function ops.record_security_event(
  event_kind text,
  event_email_hmac bytea,
  event_token_prefix text,
  event_ip_hmac bytea
) returns void
  language sql
  security definer
  set search_path = pg_catalog
as $fn$
  insert into ops.security_events (kind, email_hmac, token_prefix, ip_hmac)
  values (event_kind, event_email_hmac, event_token_prefix, event_ip_hmac)
$fn$;

-- Removes one batch of events past the 90 days they are kept, and says how many,
-- so a job can keep calling until none are left without one long delete holding
-- locks.
create function ops.delete_expired_security_events(batch_size integer) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  removed bigint;
begin
  if batch_size is null or batch_size < 1 or batch_size > 10000 then
    raise exception using
      errcode = '22023',
      message = 'a batch is from 1 to 10000 rows';
  end if;
  delete from ops.security_events as e
   where e.id in (
     select c.id
       from ops.security_events as c
      where c.occurred_at < now() - interval '90 days'
      order by c.occurred_at
      limit batch_size
   );
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

-- Sign in and token checks run as the app here, so it is the one role that
-- records events.
grant execute on function ops.record_security_event(text, bytea, text, bytea) to ujira_app;
grant execute on function ops.delete_expired_security_events(integer) to ujira_retention;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ops to ujira_ops;
alter function ops.record_security_event(text, bytea, text, bytea) owner to ujira_ops;
alter function ops.delete_expired_security_events(integer) owner to ujira_ops;
revoke create on schema ops from ujira_ops;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ops.delete_expired_security_events(integer);
drop function ops.record_security_event(text, bytea, text, bytea);
drop table ops.security_events;
revoke usage on schema ops from ujira_ops, ujira_app, ujira_retention;

reset role;

drop schema ops;
revoke ujira_ops from ujira_owner;
