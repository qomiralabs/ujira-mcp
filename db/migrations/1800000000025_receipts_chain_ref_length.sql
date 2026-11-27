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
-- Every row already in the table has no reference, since the old check could
-- not accept any, so the new check holds for all of them and is validated as
-- it is added. The table is small for the same reason, so the scan is short.

-- Up Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- squawk-ignore ban-drop-constraint
alter table ujira.receipts drop constraint receipts_chain_ref_format;
alter table ujira.receipts
  add constraint receipts_chain_ref_format check (
    chain_receipt_ref ~ '^[A-Za-z0-9:._-]+$' and char_length(chain_receipt_ref) <= 512
  );

reset role;

-- Down Migration
set local lock_timeout = '5s';
set local statement_timeout = '60s';

set local role ujira_owner;

-- Back to the check the previous migration made, so it comes down from the
-- state it went up to. A receipt with a reference stops the rollback, which is
-- the right answer: the old check cannot hold it.
-- squawk-ignore ban-drop-constraint
alter table ujira.receipts drop constraint receipts_chain_ref_format;
alter table ujira.receipts
  add constraint receipts_chain_ref_format check (chain_receipt_ref ~ '^[A-Za-z0-9:._-]{1,512}$');

reset role;
