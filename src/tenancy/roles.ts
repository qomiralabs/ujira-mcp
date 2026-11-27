// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What each member role may do. One table, so a route asks for a permission
// and never compares role names itself, and a new role is one line here.
//
// A role this code does not know gets nothing. The database stores a role as
// text, and a role added there before the code learns it must not fall
// through to some default that turns out to be generous.

import type { MemberRole } from '../db/index.js';

export const PERMISSIONS = [
  'read',
  'write',
  'manage_keys',
  'manage_members',
  'manage_projects',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<MemberRole, ReadonlySet<Permission>>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS),
  developer: new Set<Permission>(['read', 'write']),
  viewer: new Set<Permission>(['read']),
};

function knownRole(role: string): role is MemberRole {
  return Object.hasOwn(ROLE_PERMISSIONS, role);
}

/** Whether a member with this role may do this. False for a role this code does not know. */
export function can(role: string, permission: Permission): boolean {
  return knownRole(role) && ROLE_PERMISSIONS[role].has(permission);
}
