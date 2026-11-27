-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- Unsafe on purpose, and never run: scripts/lint-migrations.test.sh checks that
-- the migration lint rejects it. An index built without CONCURRENTLY holds a
-- lock that blocks every write to payouts until the build ends.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

create index payouts_created_at on ujira.payouts (created_at);

reset role;

-- Down Migration
drop index ujira.payouts_created_at;
