-- expand
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- A receipt's chain reference may be up to 512 characters, but Postgres caps
-- a regular expression bound at 255, so the check written for it with {1,512}
-- failed with "invalid repetition count(s)" on every reference it was given.
-- No receipt could carry one, and a paid payout needs one, so no payout could
-- be closed. The same rule now reads as a character class and a length.
--
-- The new check is added not valid, so nothing here scans the table under a
-- lock; the next migration validates it on its own. It holds for new rows at
-- once.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Dropped only to be replaced in the same transaction, so no row is ever
-- written without a reference check.
-- squawk-ignore ban-drop-constraint
alter table ujira.receipts drop constraint receipts_chain_ref_format;
alter table ujira.receipts
  add constraint receipts_chain_ref_format check (
    chain_receipt_ref ~ '^[A-Za-z0-9:._-]+$' and char_length(chain_receipt_ref) <= 512
  ) not valid;

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Back to the check the earlier migration made, so it comes down from the
-- state it went up to. A receipt with a reference stops the rollback, which is
-- the right answer: the old check cannot hold it.
-- squawk-ignore ban-drop-constraint
alter table ujira.receipts drop constraint receipts_chain_ref_format;
alter table ujira.receipts
  add constraint receipts_chain_ref_format check (chain_receipt_ref ~ '^[A-Za-z0-9:._-]{1,512}$');

reset role;
