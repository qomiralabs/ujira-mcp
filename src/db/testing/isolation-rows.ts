// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Two markers, one per test file, so each file can write its own and look
// for the other's. Finding the other would mean the two files shared a
// database, which is what the harness exists to prevent.

export const THIS_FILE_ROW = 'written-by-harness-test';
export const OTHER_FILE_ROW = 'written-by-isolation-test';
