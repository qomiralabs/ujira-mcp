// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The Postgres image, in a module of its own with no imports, so a script
// run directly by node can read it. A module that imports a sibling with a
// .js specifier cannot be loaded that way.
//
// Pinned, so the server is identical on a developer machine and in CI: an
// image that differs between the two can hide a defect in one of them.
export const POSTGRES_IMAGE = 'postgres:17.6';
