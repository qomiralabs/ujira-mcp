-- contract
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Every audited action comes from a fixed catalog, so the log stays consistent
-- and reviewable. Adding an action is a migration, and a change to AUDIT_ACTIONS
-- in the repository, which a test holds to this list.
--
-- Settings changes are in here rather than in a store of their own: a second store
-- would split one hash chain and leave half the administrative record without
-- tamper evidence.
--
-- Added as NOT VALID, which binds new writes at once and takes no scan. The next
-- migration checks the rows already there. If a row does not fit, the deploy
-- stops there rather than guessing.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- The catalog is stricter than the format check it replaces.
-- squawk-ignore ban-drop-constraint
alter table ujira.audit_log drop constraint audit_log_action_format;
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

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

alter table ujira.audit_log drop constraint audit_log_action_known;
alter table ujira.audit_log
  add constraint audit_log_action_format
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$') not valid;

reset role;
