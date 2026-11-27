-- expand
-- bootstrap
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- The tenant roots: principals, their projects, the people who sign in, their
-- memberships, and the API tokens a project authenticates with.
--
-- A person is a wallet. They sign in by signing a message with it, so the
-- member row is keyed by the wallet's address, and one wallet belongs to
-- several principals through one membership row in each. The member row
-- belongs to no tenant, since it exists before any principal names it, so no
-- service role can read it. A membership carries the address with it, so a
-- principal lists its own members without reading anyone else's.
--
-- Two paths have to cross tenants and cannot run under a tenant context:
-- creating a principal, which happens before the principal exists, and
-- authenticating a token, which is how the context is found. Each is a
-- security definer function owned by its own narrow role that holds only the
-- rights that one function needs, so neither runs with the owner's rights,
-- and the app role can do nothing else outside a context.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Roles are shared by the server, so they are created only if missing and are
-- never dropped by the down section.
do $roles$
declare
  definer_role text;
begin
  foreach definer_role in array array['ujira_fn_principals', 'ujira_fn_tokens'] loop
    if not exists (select from pg_catalog.pg_roles where rolname = definer_role) then
      execute format('create role %I nologin noinherit nobypassrls', definer_role);
    end if;
    -- Only when it needs it: Postgres 16 and later refuse any change to the
    -- attribute, even taking it away, from a login that does not hold it.
    if exists (
      select from pg_catalog.pg_roles where rolname = definer_role and rolbypassrls
    ) then
      execute format('alter role %I nobypassrls', definer_role);
    end if;
  end loop;
end
$roles$;

-- The owner hands each function to its role, which needs the owner to be
-- able to act as that role.
grant ujira_fn_principals to ujira_owner;
grant ujira_fn_tokens to ujira_owner;

set local role ujira_owner;

create table ujira.principals (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint principals_name_length check (char_length(name) between 1 and 200),
  -- The IANA zone that fixes every report period boundary for this
  -- principal, so one set of figures comes out whoever reads them. A
  -- trigger checks it, because a CHECK cannot hold a subquery.
  reporting_time_zone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ujira.projects (
  principal_id uuid not null references ujira.principals (id),
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint projects_name_length check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The target of every composite tenant foreign key.
  constraint projects_tenant_key unique (principal_id, id)
);

create table ujira.members (
  id uuid primary key default gen_random_uuid(),
  -- The address the person signs in with, as the chain adapter writes it.
  -- Only its shape is checked here: which chain it belongs to is the
  -- adapter's business, not the database's.
  wallet_address text not null
    constraint members_wallet_address_format check (wallet_address ~ '^[A-Za-z0-9]{1,128}$'),
  created_at timestamptz not null default now(),
  constraint members_wallet_address_key unique (wallet_address),
  -- The target of the membership's key, so the address a membership carries
  -- is always its member's.
  constraint members_identity_key unique (id, wallet_address)
);

create table ujira.principal_members (
  principal_id uuid not null references ujira.principals (id),
  member_id uuid not null,
  wallet_address text not null,
  role text not null
    constraint principal_members_role check (role in ('owner', 'admin', 'developer', 'viewer')),
  -- Whether the member can act. Removing someone keeps the row, so what they
  -- did still names them.
  status text not null default 'active'
    constraint principal_members_status check (status in ('active', 'suspended', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_id, member_id),
  constraint principal_members_wallet_key unique (principal_id, wallet_address),
  constraint principal_members_member
    foreign key (member_id, wallet_address) references ujira.members (id, wallet_address)
);

create table ujira.api_tokens (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  -- The public part of the token, how a request names it. Unique across
  -- every tenant, because it is looked up before any tenant is known.
  prefix text not null
    constraint api_tokens_prefix_format check (prefix ~ '^[A-Za-z0-9_]{8,40}$'),
  -- SHA-256 of the secret part. The secret itself is never stored.
  secret_sha256 ujira.hash32 not null,
  scopes text[] not null default '{}'
    constraint api_tokens_scopes_bounded check (cardinality(scopes) <= 32),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint api_tokens_prefix_key unique (prefix),
  constraint api_tokens_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create function ujira.check_reporting_time_zone() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if not exists (select 1 from pg_timezone_names where name = new.reporting_time_zone) then
    raise exception using
      errcode = '22023',
      message = 'reporting_time_zone is not an IANA time zone this server knows';
  end if;
  return new;
end
$fn$;

create trigger principals_reporting_time_zone
  before insert or update of reporting_time_zone on ujira.principals
  for each row execute function ujira.check_reporting_time_zone();
create trigger principals_touch before update on ujira.principals
  for each row execute function ujira.touch();
create trigger projects_touch before update on ujira.projects
  for each row execute function ujira.touch();
create trigger principal_members_touch before update on ujira.principal_members
  for each row execute function ujira.touch();

-- A revoked token stays revoked.
create function ujira.keep_token_revoked() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $fn$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception using
      errcode = 'UJ006',
      message = 'a revoked api token cannot be restored or re-revoked';
  end if;
  if new.prefix <> old.prefix or new.secret_sha256 <> old.secret_sha256
     or new.principal_id <> old.principal_id or new.project_id <> old.project_id then
    raise exception using
      errcode = 'UJ006',
      message = 'an api token keeps its prefix, secret and tenant';
  end if;
  return new;
end
$fn$;

create trigger api_tokens_keep_revoked before update on ujira.api_tokens
  for each row execute function ujira.keep_token_revoked();

-- Row level security. The principal and membership tables are principal
-- wide, so they get their own policies; projects are read across the
-- principal under scope all. Every write is refused under scope all.
alter table ujira.principals enable row level security;
alter table ujira.principals force row level security;
create policy tenant_read on ujira.principals for select to ujira_app, ujira_reader
  using (id = ujira.current_principal_id());
create policy tenant_update on ujira.principals for update to ujira_app
  using (id = ujira.current_principal_id() and not ujira.project_scope_all())
  with check (id = ujira.current_principal_id() and not ujira.project_scope_all());
create policy owner_all on ujira.principals for all to ujira_owner using (true) with check (true);
create policy create_principal on ujira.principals for insert to ujira_fn_principals
  with check (true);

alter table ujira.projects enable row level security;
alter table ujira.projects force row level security;
create policy tenant_read on ujira.projects for select to ujira_app, ujira_reader
  using (
    principal_id = ujira.current_principal_id()
    and (ujira.project_scope_all() or id = ujira.current_project_id())
  );
-- A new project belongs to the transaction's principal. Whether the caller
-- may create one is the API's decision; that it lands in the right tenant
-- is the database's.
create policy tenant_insert on ujira.projects for insert to ujira_app
  with check (principal_id = ujira.current_principal_id() and not ujira.project_scope_all());
create policy tenant_update on ujira.projects for update to ujira_app
  using (principal_id = ujira.current_principal_id() and id = ujira.current_project_id())
  with check (principal_id = ujira.current_principal_id() and id = ujira.current_project_id());
create policy owner_all on ujira.projects for all to ujira_owner using (true) with check (true);
create policy create_principal on ujira.projects for insert to ujira_fn_principals
  with check (true);

-- No service role holds a right on this table. The functions that create a
-- principal or add a member find or make the row, and nothing else reads it.
alter table ujira.members enable row level security;
alter table ujira.members force row level security;
create policy owner_all on ujira.members for all to ujira_owner using (true) with check (true);
create policy create_principal on ujira.members for insert to ujira_fn_principals
  with check (true);
create policy create_principal_read on ujira.members for select to ujira_fn_principals
  using (true);

-- A membership is added only through ujira.add_member, which makes the member
-- row it needs, so the app may change a membership's role and status here
-- but never insert one.
alter table ujira.principal_members enable row level security;
alter table ujira.principal_members force row level security;
create policy tenant_read on ujira.principal_members for select to ujira_app, ujira_reader
  using (principal_id = ujira.current_principal_id());
create policy tenant_update on ujira.principal_members for update to ujira_app
  using (principal_id = ujira.current_principal_id() and not ujira.project_scope_all())
  with check (principal_id = ujira.current_principal_id() and not ujira.project_scope_all());
create policy owner_all on ujira.principal_members for all to ujira_owner using (true) with check (true);
create policy create_principal on ujira.principal_members for insert to ujira_fn_principals
  with check (true);

select ujira.apply_tenant_policies('ujira.api_tokens');
create policy authenticate on ujira.api_tokens for select to ujira_fn_tokens using (true);

grant select, update on ujira.principals to ujira_app;
grant select on ujira.principals to ujira_reader;
grant select, insert, update on ujira.projects to ujira_app;
grant select on ujira.projects to ujira_reader;
-- Column grants, so a membership can never be moved to another person.
grant select, update (role, status) on ujira.principal_members to ujira_app;
grant select on ujira.principal_members to ujira_reader;
grant select, insert, update on ujira.api_tokens to ujira_app;
grant select on ujira.api_tokens to ujira_reader;

grant usage on schema ujira to ujira_fn_principals, ujira_fn_tokens;
grant insert on ujira.principals, ujira.projects, ujira.principal_members to ujira_fn_principals;
grant select, insert on ujira.members to ujira_fn_principals;
grant select on ujira.api_tokens to ujira_fn_tokens;
-- add_member reads the transaction's tenant, as the policies do.
grant execute on function ujira.current_principal_id(), ujira.project_scope_all()
  to ujira_fn_principals;

-- Creates a principal with its first project and its owner, all or nothing:
-- the inserts are one statement's work, so a failure in any leaves none. The
-- owner's member row is found or made by its address, so a wallet that
-- already belongs to another principal stays one person.
create function ujira.create_principal(
  principal_name text,
  project_name text,
  owner_wallet text,
  reporting_time_zone text default 'UTC'
) returns table (principal_id uuid, project_id uuid, member_id uuid)
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  new_principal uuid := gen_random_uuid();
  new_project uuid := gen_random_uuid();
  owner_member uuid;
begin
  insert into ujira.principals (id, name, reporting_time_zone)
    values (new_principal, principal_name, create_principal.reporting_time_zone);
  insert into ujira.projects (principal_id, id, name)
    values (new_principal, new_project, project_name);
  insert into ujira.members (wallet_address) values (owner_wallet)
    on conflict (wallet_address) do nothing;
  select m.id into strict owner_member from ujira.members as m where m.wallet_address = owner_wallet;
  insert into ujira.principal_members (principal_id, member_id, wallet_address, role)
    values (new_principal, owner_member, owner_wallet, 'owner');
  return query select new_principal, new_project, owner_member;
end
$fn$;

-- Adds a wallet to the transaction's principal and returns its member id. The
-- principal comes from the context, never from an argument, so no caller can
-- add a member to a principal it is not acting for. A wallet already in the
-- principal is refused by the unique key, 23505.
create function ujira.add_member(member_wallet text, member_role text) returns uuid
  language plpgsql
  security definer
  set search_path = pg_catalog
as $fn$
declare
  acting_principal uuid := ujira.current_principal_id();
  added_member uuid;
begin
  -- Scope all reads and never writes, under every policy, so here too.
  if ujira.project_scope_all() then
    raise exception using
      errcode = '42501',
      message = 'a member cannot be added under scope all';
  end if;
  insert into ujira.members (wallet_address) values (member_wallet)
    on conflict (wallet_address) do nothing;
  select m.id into strict added_member from ujira.members as m where m.wallet_address = member_wallet;
  insert into ujira.principal_members (principal_id, member_id, wallet_address, role)
    values (acting_principal, added_member, member_wallet, member_role);
  return added_member;
end
$fn$;

-- The token named by its prefix, whatever tenant it belongs to, or no row.
-- The caller compares the secret's hash in constant time and checks expiry
-- and revocation; this only finds the one row the prefix names.
create function ujira.authenticate_token(token_prefix text)
  returns table (
    token_id uuid,
    principal_id uuid,
    project_id uuid,
    secret_sha256 bytea,
    scopes text[],
    expires_at timestamptz,
    revoked_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select t.id, t.principal_id, t.project_id, t.secret_sha256::bytea, t.scopes, t.expires_at, t.revoked_at
    from ujira.api_tokens as t
   where t.prefix = token_prefix
$fn$;

revoke all on function ujira.create_principal(text, text, text, text) from public;
revoke all on function ujira.add_member(text, text) from public;
revoke all on function ujira.authenticate_token(text) from public;
grant execute on function ujira.create_principal(text, text, text, text) to ujira_app;
grant execute on function ujira.add_member(text, text) to ujira_app;
grant execute on function ujira.authenticate_token(text) to ujira_app;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_principals, ujira_fn_tokens;
alter function ujira.create_principal(text, text, text, text) owner to ujira_fn_principals;
alter function ujira.add_member(text, text) owner to ujira_fn_principals;
alter function ujira.authenticate_token(text) owner to ujira_fn_tokens;
revoke create on schema ujira from ujira_fn_principals, ujira_fn_tokens;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.authenticate_token(text);
drop function ujira.add_member(text, text);
drop function ujira.create_principal(text, text, text, text);
drop table ujira.api_tokens;
drop function ujira.keep_token_revoked();
drop table ujira.principal_members;
drop table ujira.members;
drop table ujira.projects;
drop table ujira.principals;
drop function ujira.check_reporting_time_zone();
revoke execute on function ujira.current_principal_id(), ujira.project_scope_all()
  from ujira_fn_principals;
revoke usage on schema ujira from ujira_fn_principals, ujira_fn_tokens;

-- The role and the owner's membership of it stay: roles are shared by every
-- database on the server, and another one may still hand functions to it.
reset role;
