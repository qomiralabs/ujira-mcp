// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Imports the driver from outside src/db on purpose. ESLint ignores this
// file in a normal run; src/db/db-lint.test.ts lints it to prove the fence
// refuses it.

import pg from 'pg';

export const client = pg.Client;
