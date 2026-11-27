-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Creating a principal or a project is an administrative action, so it goes in
-- the audit log with everything else.
--
-- A project is created inside a tenant transaction, so the API writes its row
-- with the repository. A principal is not: it is created before any tenant
-- context can name it, by ujira.create_principal. That function now writes the
-- principal's first audit row itself, in the same statement as the principal,
-- so no principal can exist without the record of who made it, whichever
-- caller made it.
--
-- The catalog is added as NOT VALID, as before, and the next migration checks
-- the rows already there.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- squawk-ignore ban-drop-constraint
alter table ujira.audit_log drop constraint audit_log_action_known;
alter table ujira.audit_log
  add constraint audit_log_action_known check (
    action in (
      'session.signed_in',
      'session.signed_out',
      'session.stepped_up',
      'member.invited',
      'member.added',
      'member.removed',
      'member.role_changed',
      'api_key.created',
      'api_key.rotated',
      'api_key.revoked',
      'webhook.endpoint_created',
      'webhook.endpoint_updated',
      'webhook.endpoint_deleted',
      'webhook.secret_rotated',
      'export.requested',
      'export.downloaded',
      'identity.verification_started',
      'identity.verification_completed',
      'identity.verification_revoked',
      'identity.pii_viewed',
      'principal.created',
      'principal.reporting_time_zone_changed',
      'project.created',
      'project.routing_settings_changed',
      'project.payout_minimums_changed',
      'project.cashout_bearer_changed',
      'fee_terms.recorded'
    )
  ) not valid;

-- create_principal may write one kind of audit row and nothing else. The chain
-- trigger moves the head as its own role, so this role needs no right on the
-- heads.
grant insert on ujira.audit_log to ujira_fn_principals;
grant usage on domain ujira.hash32 to ujira_fn_principals;
create policy create_principal on ujira.audit_log for insert to ujira_fn_principals
  with check (action = 'principal.created' and actor_kind = 'member');

-- The same function as before, with the audit row at the end. The owner stays
-- ujira_fn_principals, since replacing a function keeps its owner.
create or replace function ujira.create_principal(
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
  -- The chain trigger overwrites the sequence and both hashes; these only
  -- satisfy the columns until it does.
  placeholder bytea := decode(repeat('00', 32), 'hex');
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
  insert into ujira.audit_log
      (principal_id, project_id, action, actor_kind, actor_id, seq, prev_hash, row_hash)
    values
      (new_principal, new_project, 'principal.created', 'member', owner_member, 0,
       placeholder, placeholder);
  return query select new_principal, new_project, owner_member;
end
$fn$;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create or replace function ujira.create_principal(
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

drop policy create_principal on ujira.audit_log;
revoke usage on domain ujira.hash32 from ujira_fn_principals;
revoke insert on ujira.audit_log from ujira_fn_principals;

-- Back to the earlier catalog, checked here rather than left NOT VALID, so the
-- migration before this one comes down from the state it went up to. A row
-- with one of the two new actions stops the rollback, which is the right
-- answer: the log is append only, and those rows cannot be explained away.
-- squawk-ignore ban-drop-constraint
alter table ujira.audit_log drop constraint audit_log_action_known;
alter table ujira.audit_log
  add constraint audit_log_action_known check (
    action in (
      'session.signed_in',
      'session.signed_out',
      'session.stepped_up',
      'member.invited',
      'member.added',
      'member.removed',
      'member.role_changed',
      'api_key.created',
      'api_key.rotated',
      'api_key.revoked',
      'webhook.endpoint_created',
      'webhook.endpoint_updated',
      'webhook.endpoint_deleted',
      'webhook.secret_rotated',
      'export.requested',
      'export.downloaded',
      'identity.verification_started',
      'identity.verification_completed',
      'identity.verification_revoked',
      'identity.pii_viewed',
      'principal.reporting_time_zone_changed',
      'project.routing_settings_changed',
      'project.payout_minimums_changed',
      'project.cashout_bearer_changed',
      'fee_terms.recorded'
    )
  ) not valid;
alter table ujira.audit_log validate constraint audit_log_action_known;

reset role;
