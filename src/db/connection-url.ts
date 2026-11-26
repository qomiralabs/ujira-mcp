// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A database URL, which carries its role's password, held so that printing
// the configuration cannot print it.
//
// Two independent things have to fail before it shows. The value sits in a
// private field, which no property walk reaches: the test runner's error
// serialiser walks every own property name, enumerable or not, and so prints
// what pg marks non-enumerable to hide. And toJSON answers a placeholder,
// which that serialiser consults before it walks anything, as JSON.stringify
// does. A Node inspect hook is deliberately not relied on: the runner never
// consults one.

const PLACEHOLDER = '[database url withheld]';

export class ConnectionUrl {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  // The one way to the value, for handing to the driver. Named so a reader
  // can find every place that does it.
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return PLACEHOLDER;
  }

  toString(): string {
    return PLACEHOLDER;
  }
}

export const CONNECTION_URL_PLACEHOLDER = PLACEHOLDER;
