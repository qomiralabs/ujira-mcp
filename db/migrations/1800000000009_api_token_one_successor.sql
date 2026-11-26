-- expand
-- no-transaction
-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Qomira Labs
--
-- A key is rotated once: two rotations racing must not leave two live successors,
-- because a key nobody was shown would then stay valid.

-- Up Migration
-- One statement, so no timeout can be set before it, and a concurrent build holds
-- no lock that stops traffic.
create unique index concurrently if not exists api_tokens_one_successor
  on ujira.api_tokens (principal_id, project_id, rotated_from_id)
  where rotated_from_id is not null;

-- Down Migration
drop index concurrently if exists ujira.api_tokens_one_successor;
