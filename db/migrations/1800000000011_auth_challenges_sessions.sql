-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Wallet sign in: the one time challenges a wallet signs, and the dashboard
-- sessions they are traded for.
--
-- Both belong to a person rather than a tenant. A challenge is issued before
-- anyone is known, and a session is how the server learns which principals a
-- person may act for, so neither can run under a tenant context. Every read
-- and write goes through a security definer function owned by its own narrow
-- role, and no service role can touch either table itself.
--
-- A session is found by the SHA-256 of its secret, so holding the secret is
-- what lets a caller act on it, and the secret itself is never stored. A
-- session names no tenant: each request names its project, and the session
-- resolves against that project's membership every time, so removing someone
-- ends their access on their next request and not when the session lapses.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so this is created only if missing and is
-- never dropped by the down section.
do $roles$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'ujira_fn_sessions') then
    create role ujira_fn_sessions nologin noinherit nobypassrls;
  end if;
  -- Only when it needs it: Postgres 16 and later refuse any change to the
  -- attribute, even taking it away, from a login that does not hold it.
  if exists (
    select from pg_catalog.pg_roles where rolname = 'ujira_fn_sessions' and rolbypassrls
  ) then
    alter role ujira_fn_sessions nobypassrls;
  end if;
end
$roles$;

grant ujira_fn_sessions to ujira_owner;

set local role ujira_owner;

create table ujira.auth_challenges (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null
    constraint auth_challenges_wallet_address_format check (wallet_address ~ '^[A-Za-z0-9]{1,128}$'),
  -- The exact text the wallet signs, kept whole, because a signature is
  -- checked against these bytes and nothing rebuilt from them.
  message text not null
    constraint auth_challenges_message_length check (char_length(message) between 1 and 2000),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Ten minutes at most, whatever a caller asks for.
  constraint auth_challenges_lifetime
    check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);

create index auth_challenges_retention on ujira.auth_challenges (expires_at);

create table ujira.sessions (
  id uuid primary key default gen_random_uuid(),
  token_sha256 ujira.hash32 not null constraint sessions_token_sha256_key unique,
  member_id uuid not null references ujira.members (id),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
    constraint sessions_reason_format check (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  constraint sessions_idle_within_absolute check (idle_expires_at <= absolute_expires_at),
  constraint sessions_revocation_whole check ((revoked_at is null) = (revoked_reason is null))
);

create index sessions_member on ujira.sessions (member_id);
create index sessions_retention on ujira.sessions (absolute_expires_at);

alter table ujira.auth_challenges enable row level security;
alter table ujira.auth_challenges force row level security;
create policy owner_all on ujira.auth_challenges for all to ujira_owner using (true) with check (true);
create policy sessions_all on ujira.auth_challenges for all to ujira_fn_sessions
  using (true) with check (true);

alter table ujira.sessions enable row level security;
alter table ujira.sessions force row level security;
create policy owner_all on ujira.sessions for all to ujira_owner using (true) with check (true);
create policy sessions_all on ujira.sessions for all to ujira_fn_sessions
  using (true) with check (true);

-- What a session needs to say who someone is and where they belong.
create policy sessions_read on ujira.members for select to ujira_fn_sessions using (true);
create policy sessions_insert on ujira.members for insert to ujira_fn_sessions with check (true);
create policy sessions_read on ujira.principal_members for select to ujira_fn_sessions using (true);
create policy sessions_read on ujira.principals for select to ujira_fn_sessions using (true);
create policy sessions_read on ujira.projects for select to ujira_fn_sessions using (true);

revoke all on ujira.auth_challenges, ujira.sessions from public;
grant usage on schema ujira to ujira_fn_sessions;
grant usage on domain ujira.hash32 to ujira_fn_sessions;
grant select, insert, update, delete on ujira.auth_challenges, ujira.sessions to ujira_fn_sessions;
grant select, insert on ujira.members to ujira_fn_sessions;
grant select on ujira.principal_members, ujira.principals, ujira.projects to ujira_fn_sessions;

-- A challenge for a wallet to sign. The lifetime is counted by the database
-- clock, so the expiry every later check reads comes from one clock.
create function ujira.auth_challenge_create(
  wallet text,
  challenge_message text,
  ttl_seconds integer
) returns table (challenge_id uuid, expires_at timestamptz)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
begin
  if ttl_seconds is null or ttl_seconds < 1 or ttl_seconds > 600 then
    raise exception using errcode = '22023', message = 'a challenge lasts from 1 to 600 seconds';
  end if;
  return query
    insert into ujira.auth_challenges as c (wallet_address, message, expires_at)
      values (wallet, challenge_message, now() + make_interval(secs => ttl_seconds))
    returning c.id, c.expires_at;
end
$fn$;

-- Spends a challenge and returns the text that was signed, or null when it is
-- unknown, spent, lapsed or issued to another wallet. It is spent before the
-- signature is checked, so a wrong signature uses it up too and a challenge
-- can never be tried twice.
create function ujira.auth_challenge_consume(challenge uuid, wallet text) returns text
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  signed text;
begin
  update ujira.auth_challenges as c
     set consumed_at = now()
   where c.id = challenge
     and c.wallet_address = wallet
     and c.consumed_at is null
     and c.expires_at > now()
  returning c.message into signed;
  return signed;
end
$fn$;

-- A session for the person behind a wallet whose signature the caller has
-- checked. Their member row is found or made by its address.
create function ujira.session_create(
  session_token_sha256 bytea,
  wallet text,
  idle_seconds integer,
  absolute_seconds integer
) returns table (
  session_id uuid,
  member_id uuid,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  person uuid;
begin
  if idle_seconds is null or idle_seconds < 1 or absolute_seconds is null or absolute_seconds < 1 then
    raise exception using errcode = '22023', message = 'a session lasts at least a second';
  end if;
  insert into ujira.members (wallet_address) values (wallet)
    on conflict (wallet_address) do nothing;
  select m.id into strict person from ujira.members as m where m.wallet_address = wallet;
  return query
    insert into ujira.sessions as s (token_sha256, member_id, idle_expires_at, absolute_expires_at)
      values (
        session_token_sha256::ujira.hash32,
        person,
        now() + make_interval(secs => least(idle_seconds, absolute_seconds)),
        now() + make_interval(secs => absolute_seconds)
      )
    returning s.id, s.member_id, s.idle_expires_at, s.absolute_expires_at;
end
$fn$;

-- The live session behind a secret, or no row. With a project, also the
-- principal it belongs to and the person's role there, all three null unless
-- the person is an active member of that principal, so a request naming a
-- project it has no right to learns nothing about it.
create function ujira.session_resolve(session_token_sha256 bytea, selected_project uuid)
  returns table (
    session_id uuid,
    member_id uuid,
    wallet_address text,
    idle_expires_at timestamptz,
    absolute_expires_at timestamptz,
    principal_id uuid,
    project_id uuid,
    member_role text
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select s.id, s.member_id, m.wallet_address, s.idle_expires_at, s.absolute_expires_at,
         access.principal_id, access.project_id, access.role
    from ujira.sessions as s
    join ujira.members as m on m.id = s.member_id
    left join lateral (
      select p.principal_id, p.id as project_id, pm.role
        from ujira.projects as p
        join ujira.principal_members as pm
          on pm.principal_id = p.principal_id
         and pm.member_id = s.member_id
         and pm.status = 'active'
       where p.id = selected_project
    ) as access on true
   where s.token_sha256 = session_token_sha256::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
$fn$;

-- The principals the person behind a live session may act for, with their
-- role in each. Nothing for a session that is not live.
create function ujira.session_principals(session_token_sha256 bytea)
  returns table (principal_id uuid, name text, role text)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select p.id, p.name, pm.role
    from ujira.sessions as s
    join ujira.principal_members as pm on pm.member_id = s.member_id and pm.status = 'active'
    join ujira.principals as p on p.id = pm.principal_id
   where s.token_sha256 = session_token_sha256::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
   order by p.created_at, p.id
$fn$;

-- Every project of every principal the person behind a live session may act
-- for. Nothing for a session that is not live.
create function ujira.session_projects(session_token_sha256 bytea)
  returns table (project_id uuid, principal_id uuid, name text, created_at timestamptz)
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select p.id, p.principal_id, p.name, p.created_at
    from ujira.sessions as s
    join ujira.principal_members as pm on pm.member_id = s.member_id and pm.status = 'active'
    join ujira.projects as p on p.principal_id = pm.principal_id
   where s.token_sha256 = session_token_sha256::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
   order by p.principal_id, p.created_at, p.id
$fn$;

-- Extends a live session's idle window, never past its absolute expiry, and
-- never brings a lapsed one back. Null when there is nothing to extend.
create function ujira.session_touch(session_token_sha256 bytea, idle_seconds integer)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  extended timestamptz;
begin
  if idle_seconds is null or idle_seconds < 1 then
    raise exception using errcode = '22023', message = 'a session lasts at least a second';
  end if;
  update ujira.sessions as s
     set idle_expires_at = least(now() + make_interval(secs => idle_seconds), s.absolute_expires_at)
   where s.token_sha256 = session_token_sha256::ujira.hash32
     and s.revoked_at is null
     and s.idle_expires_at > now()
     and s.absolute_expires_at > now()
  returning s.idle_expires_at into extended;
  return extended;
end
$fn$;

create function ujira.session_revoke(session_token_sha256 bytea, reason text)
  returns boolean
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  changed integer;
begin
  update ujira.sessions as s
     set revoked_at = now(), revoked_reason = reason
   where s.token_sha256 = session_token_sha256::ujira.hash32 and s.revoked_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end
$fn$;

-- Removes one batch of lapsed challenges and says how many, so a job can keep
-- calling until none are left without one long delete holding locks.
create function ujira.auth_challenges_delete_expired(batch_size integer)
  returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  removed bigint;
begin
  if batch_size is null or batch_size < 1 or batch_size > 10000 then
    raise exception using errcode = '22023', message = 'a batch is from 1 to 10000 rows';
  end if;
  delete from ujira.auth_challenges as c
   where c.id in (
     select l.id
       from ujira.auth_challenges as l
      where l.expires_at < now()
      order by l.expires_at
      limit batch_size
   );
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

-- The same for sessions 30 days past their expiry or revocation, kept that
-- long so a question about a session can still be answered.
create function ujira.sessions_delete_expired(batch_size integer)
  returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  removed bigint;
begin
  if batch_size is null or batch_size < 1 or batch_size > 10000 then
    raise exception using errcode = '22023', message = 'a batch is from 1 to 10000 rows';
  end if;
  delete from ujira.sessions as s
   where s.id in (
     select l.id
       from ujira.sessions as l
      where least(l.revoked_at, l.idle_expires_at, l.absolute_expires_at) < now() - interval '30 days'
      order by l.absolute_expires_at
      limit batch_size
   );
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

revoke all on function ujira.auth_challenge_create(text, text, integer) from public;
revoke all on function ujira.auth_challenge_consume(uuid, text) from public;
revoke all on function ujira.session_create(bytea, text, integer, integer) from public;
revoke all on function ujira.session_resolve(bytea, uuid) from public;
revoke all on function ujira.session_principals(bytea) from public;
revoke all on function ujira.session_projects(bytea) from public;
revoke all on function ujira.session_touch(bytea, integer) from public;
revoke all on function ujira.session_revoke(bytea, text) from public;
revoke all on function ujira.auth_challenges_delete_expired(integer) from public;
revoke all on function ujira.sessions_delete_expired(integer) from public;

grant execute on function
  ujira.auth_challenge_create(text, text, integer),
  ujira.auth_challenge_consume(uuid, text),
  ujira.session_create(bytea, text, integer, integer),
  ujira.session_resolve(bytea, uuid),
  ujira.session_principals(bytea),
  ujira.session_projects(bytea),
  ujira.session_touch(bytea, integer),
  ujira.session_revoke(bytea, text)
  to ujira_app;
-- Pruning is a scheduled job, so it is the worker's alone.
grant execute on function
  ujira.auth_challenges_delete_expired(integer),
  ujira.sessions_delete_expired(integer)
  to ujira_worker;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_sessions;
alter function ujira.auth_challenge_create(text, text, integer) owner to ujira_fn_sessions;
alter function ujira.auth_challenge_consume(uuid, text) owner to ujira_fn_sessions;
alter function ujira.session_create(bytea, text, integer, integer) owner to ujira_fn_sessions;
alter function ujira.session_resolve(bytea, uuid) owner to ujira_fn_sessions;
alter function ujira.session_principals(bytea) owner to ujira_fn_sessions;
alter function ujira.session_projects(bytea) owner to ujira_fn_sessions;
alter function ujira.session_touch(bytea, integer) owner to ujira_fn_sessions;
alter function ujira.session_revoke(bytea, text) owner to ujira_fn_sessions;
alter function ujira.auth_challenges_delete_expired(integer) owner to ujira_fn_sessions;
alter function ujira.sessions_delete_expired(integer) owner to ujira_fn_sessions;
revoke create on schema ujira from ujira_fn_sessions;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.sessions_delete_expired(integer);
drop function ujira.auth_challenges_delete_expired(integer);
drop function ujira.session_revoke(bytea, text);
drop function ujira.session_touch(bytea, integer);
drop function ujira.session_projects(bytea);
drop function ujira.session_principals(bytea);
drop function ujira.session_resolve(bytea, uuid);
drop function ujira.session_create(bytea, text, integer, integer);
drop function ujira.auth_challenge_consume(uuid, text);
drop function ujira.auth_challenge_create(text, text, integer);

revoke select on ujira.principal_members, ujira.principals, ujira.projects from ujira_fn_sessions;
revoke select, insert on ujira.members from ujira_fn_sessions;
drop policy sessions_read on ujira.projects;
drop policy sessions_read on ujira.principals;
drop policy sessions_read on ujira.principal_members;
drop policy sessions_insert on ujira.members;
drop policy sessions_read on ujira.members;
drop table ujira.sessions;
drop table ujira.auth_challenges;

revoke usage on domain ujira.hash32 from ujira_fn_sessions;
revoke usage on schema ujira from ujira_fn_sessions;

-- The role and the owner's membership of it stay: roles are shared by every
-- database on the server, and another one may still hand functions to it.
reset role;
