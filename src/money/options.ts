// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/**
 * True only for a plain record: an object whose prototype is Object.prototype
 * or null. Class instances, arrays and objects built on another object are
 * refused, so no field can come from a prototype the caller did not write.
 * A Proxy can claim any prototype here, which is why readOwnField does not
 * trust this check and looks only at own fields.
 */
export function isPlainRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads one own field of a record, exactly once. A field the record does not
 * own counts as absent, whatever its prototype chain or a Proxy's get trap
 * would answer, so neither a polluted prototype nor a Proxy that lies about
 * its prototype can supply a value the caller did not set.
 */
export function readOwnField(record: object, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/**
 * Reads one entry a list holds itself. A hole, an index past the end and
 * anything that is not a non-negative integer index read as undefined, so a
 * polluted Array.prototype or Object.prototype can never answer for the list.
 */
export function readOwnIndex(list: readonly unknown[], index: unknown): unknown {
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return undefined;
  return Object.hasOwn(list, index) ? list[index] : undefined;
}
