// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// What the test runner prints for a thrown value, measured against the
// installed runner. A failing test once printed a live database password
// that nothing had logged: the runner walked an error's properties and
// reached the one pg hides from logs. These pin which protections hold under
// that walk, so nobody swaps one for another that only looks equivalent.

import { inspect } from 'node:util';

import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadRunnerSerialiser, type Serialise } from './testing/runner-serialiser.js';

// Built at run time, so the value under test is not a literal in the source
// a failure's code frame could show.
const PROBE = ['leak', 'probe', String(process.pid)].join('-');
const PLACEHOLDER = '[withheld]';

let serialise: Serialise;

beforeAll(async () => {
  serialise = await loadRunnerSerialiser();
});

function printed(value: unknown): string {
  return JSON.stringify(serialise(value));
}

function failingWith(detail: Record<string, unknown>): Error {
  return Object.assign(new Error('the query failed'), detail);
}

describe("the runner's error serialiser", () => {
  it("prints the password pg hides from logs, so pg's hiding is no protection here", () => {
    const url = new URL('postgresql://app@127.0.0.1:5432/app');
    url.password = PROBE;
    const client = new pg.Client({ connectionString: url.toString() });
    // pg's own protection: not enumerable, so not in a log of the client.
    expect(Object.keys(client)).not.toContain('password');
    expect(Object.getOwnPropertyNames(client)).toContain('password');
    expect(printed(failingWith({ client }))).toContain(PROBE);
  });

  it('honours toJSON before walking anything, wherever the secret is held', () => {
    class OwnField {
      readonly value = PROBE;
      toJSON(): string {
        return PLACEHOLDER;
      }
    }
    class Private {
      readonly #value = PROBE;
      toJSON(): string {
        return PLACEHOLDER;
      }
      length(): number {
        return this.#value.length;
      }
    }
    for (const held of [new OwnField(), new Private()]) {
      const out = printed(failingWith({ config: { nested: { held } } }));
      expect(out).not.toContain(PROBE);
      expect(out).toContain(PLACEHOLDER);
    }
  });

  it('does not consult a Node inspect hook, which only helps console logging', () => {
    const hooked = {
      value: PROBE,
      [inspect.custom]: (): string => PLACEHOLDER,
    };
    // The hook works for inspect, which is what makes it look sufficient.
    expect(inspect(hooked)).not.toContain(PROBE);
    // And the runner never asks it.
    expect(printed(failingWith({ hooked }))).toContain(PROBE);
  });

  it('keeps a private field out of the walk even with no toJSON', () => {
    class Private {
      readonly #value = PROBE;
      length(): number {
        return this.#value.length;
      }
    }
    expect(printed(failingWith({ held: new Private() }))).not.toContain(PROBE);
  });

  it('prints a marker for a getter that throws, rather than failing', () => {
    const throwing = {
      get value(): string {
        throw new Error('no');
      },
    };
    expect(printed(failingWith({ throwing }))).toContain('<unserializable>');
  });
});
