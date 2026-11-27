-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
-- Fixture for migrate.test.ts: a table for the migrations after it.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table public.things (id bigint primary key);

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop table public.things;
