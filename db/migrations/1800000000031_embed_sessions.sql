-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Embed sessions: the short lived tokens that let the onboarding widget act
-- for one recipient, and the pages each project lets the widget run on.
--
-- A session is found by the SHA-256 of its token's secret, so holding the
-- token is what lets a caller use it, and the token itself is never stored.
-- The widget has no tenant until its token is looked up, so the lookup is one
-- security definer function, owned by the role that already finds API keys,
-- and it returns only live sessions: unknown, lapsed and revoked read the same.
--
-- Everything else about a session, making it, listing and revoking, runs as
-- the app under the tenant policies like any other tenant row. A session ends
-- by being revoked, never by being changed in any other way, so revoked_at is
-- the only column the app may update.
--
-- Pruning is the worker's, through one function that removes a batch of
-- sessions a week past their end and nothing else.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create table ujira.embed_sessions (
  principal_id uuid not null,
  project_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null,
  token_sha256 ujira.hash32 not null constraint embed_sessions_token_sha256_key unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- From five minutes to seven days, whatever a caller asks for.
  constraint embed_sessions_lifetime check (
    expires_at >= created_at + interval '5 minutes'
    and expires_at <= created_at + interval '7 days'
  ),
  constraint embed_sessions_revoked_after_created check (revoked_at is null or revoked_at >= created_at),
  constraint embed_sessions_tenant_key unique (principal_id, project_id, id),
  foreign key (principal_id, project_id, recipient_id)
    references ujira.recipients (principal_id, project_id, id)
);

-- The dashboard lists one recipient's links newest first.
create index embed_sessions_by_recipient
  on ujira.embed_sessions (principal_id, project_id, recipient_id, created_at desc, id desc);
create index embed_sessions_retention on ujira.embed_sessions (expires_at);

-- An origin is compared character for character with what a browser sends,
-- so only the exact form a browser sends is stored: https, or http on the
-- developer's own machine, a lower case host, an optional port, no path.
-- Origins hold no spaces, so the joined list is checked in one expression.
create table ujira.embed_settings (
  principal_id uuid not null,
  project_id uuid not null,
  allowed_origins text[] not null default '{}'
    constraint embed_settings_allowed_origins_format check (
      cardinality(allowed_origins) <= 10
      and array_position(allowed_origins, null) is null
      and array_to_string(allowed_origins, ' ')
        ~ '^((https://[a-z0-9.-]{1,253}(:[0-9]{1,5})?|http://localhost(:[0-9]{1,5})?)( |$))*$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_id, project_id),
  foreign key (principal_id, project_id) references ujira.projects (principal_id, id)
);

create trigger embed_settings_touch before update on ujira.embed_settings
  for each row execute function ujira.touch();

select ujira.apply_tenant_policies('ujira.embed_sessions');
select ujira.apply_tenant_policies('ujira.embed_settings');

grant select, insert on ujira.embed_sessions to ujira_app;
grant update (revoked_at) on ujira.embed_sessions to ujira_app;
grant select, insert on ujira.embed_settings to ujira_app;
grant update (allowed_origins) on ujira.embed_settings to ujira_app;

-- What the lookup and the prune need, and nothing else.
create policy embed_resolve on ujira.embed_sessions for select to ujira_fn_tokens using (true);
create policy embed_prune on ujira.embed_sessions for delete to ujira_fn_tokens using (true);
create policy embed_resolve on ujira.embed_settings for select to ujira_fn_tokens using (true);
grant select, delete on ujira.embed_sessions to ujira_fn_tokens;
grant select on ujira.embed_settings to ujira_fn_tokens;
grant usage on domain ujira.hash32 to ujira_fn_tokens;

-- The live session behind a token's hash, whatever its tenant, with the pages
-- its project allows, or no row. The argument is not named after the column,
-- which would win over it inside the query and match every row.
create function ujira.embed_session_resolve(secret_sha256 bytea)
  returns table (
    session_id uuid,
    principal_id uuid,
    project_id uuid,
    recipient_id uuid,
    expires_at timestamptz,
    allowed_origins text[]
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog
as $fn$
  select s.id, s.principal_id, s.project_id, s.recipient_id, s.expires_at,
         coalesce(e.allowed_origins, array[]::text[])
    from ujira.embed_sessions as s
    left join ujira.embed_settings as e
      on e.principal_id = s.principal_id and e.project_id = s.project_id
   where s.token_sha256 = secret_sha256::ujira.hash32
     and s.revoked_at is null
     and s.expires_at > now()
$fn$;

-- Removes one batch of sessions a week past their expiry or revocation and
-- says how many, so the job can keep calling until none are left without one
-- long delete holding locks. The week lets a question about a link that just
-- stopped working still be answered.
create function ujira.embed_sessions_delete_expired(batch_size integer)
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
  delete from ujira.embed_sessions as s
   where s.id in (
     select l.id
       from ujira.embed_sessions as l
      where least(l.revoked_at, l.expires_at) < now() - interval '7 days'
      order by l.expires_at
      limit batch_size
   );
  get diagnostics removed = row_count;
  return removed;
end
$fn$;

revoke all on function ujira.embed_session_resolve(bytea) from public;
revoke all on function ujira.embed_sessions_delete_expired(integer) from public;
grant execute on function ujira.embed_session_resolve(bytea) to ujira_app;
grant execute on function ujira.embed_sessions_delete_expired(integer) to ujira_worker;

-- Handing a function to another role needs that role to hold CREATE on the
-- schema, so it is granted for the handover only.
grant create on schema ujira to ujira_fn_tokens;
alter function ujira.embed_session_resolve(bytea) owner to ujira_fn_tokens;
alter function ujira.embed_sessions_delete_expired(integer) owner to ujira_fn_tokens;
revoke create on schema ujira from ujira_fn_tokens;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

drop function ujira.embed_sessions_delete_expired(integer);
drop function ujira.embed_session_resolve(bytea);
revoke usage on domain ujira.hash32 from ujira_fn_tokens;
drop table ujira.embed_settings;
drop table ujira.embed_sessions;

reset role;
