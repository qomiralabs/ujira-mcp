// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The function the test runner uses to turn a thrown value into what it
// prints, loaded from the installed runner rather than copied from its
// documentation. The runner does not export it; the root vitest config finds
// the file that defines it and aliases it to the specifier imported here.
// A runner upgrade that renames or moves it makes this fail, which is the
// point: the tests that use it pin the behaviour of the exact version
// installed, and must be read again when that changes.

export type Serialise = (value: unknown) => unknown;

const NAME = 'serializeValue';

export async function loadRunnerSerialiser(): Promise<Serialise> {
  const chunk = (await import('vitest-runner-serialiser')) as unknown as Readonly<
    Record<string, unknown>
  >;
  const found = Object.values(chunk).find(
    (value): value is Serialise => typeof value === 'function' && value.name === NAME,
  );
  if (found === undefined) {
    throw new Error(
      `the runner no longer exports a function named ${NAME}; read these tests again`,
    );
  }
  return found;
}
