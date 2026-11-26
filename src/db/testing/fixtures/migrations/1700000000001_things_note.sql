-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
-- Fixture for migrate.test.ts: the column the concurrent index after it is
-- built on.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.things add column note text;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.things drop column note;
