// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The passwords the test container's logins use. They are fixed and written
// down on purpose. A random password per run made a value that looked like a
// secret in a place that never needed one, and a failing test then printed it:
// the runner's error serialiser walks every own property, including the one
// pg hides from logs. A fixed password keeps real password authentication in
// the test path and leaves nothing worth printing.
//
// The marker is distinctive so CI can search the test output for it. Seeing
// it there means some error or log carried a connection setting, which would
// have been a real password anywhere but here.
//
// No imports, so a script run directly by node can read it, as image.ts.

export const HARNESS_PASSWORD_MARKER = 'ujira-harness-login-not-secret';

// The container's superuser.
export const HARNESS_ADMIN_PASSWORD = `${HARNESS_PASSWORD_MARKER}-admin`;

// One per login role, so a test that connects as the wrong role still fails
// authentication rather than passing on a shared password.
export function harnessPassword(role: string): string {
  return `${HARNESS_PASSWORD_MARKER}-${role}`;
}
