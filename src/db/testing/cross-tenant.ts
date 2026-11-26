// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Every repository method must have a cross-tenant case: one that runs it as
// one tenant against another tenant's ids and shows it finds nothing,
// returns an empty page or is refused. This compares the methods with the
// cases, so a method added without a case fails the matrix rather than
// going untested.

export type Repositories = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export function methodNames(repositories: Repositories): string[] {
  return Object.entries(repositories)
    .flatMap(([repository, methods]) =>
      Object.entries(methods)
        .filter(([, value]) => typeof value === 'function')
        .map(([method]) => `${repository}.${method}`),
    )
    .sort();
}

export function caseProblems(repositories: Repositories, cases: readonly string[]): string[] {
  const methods = methodNames(repositories);
  const known = new Set(cases);
  const listed = new Set(methods);
  return [
    ...methods.filter((name) => !known.has(name)).map((name) => `${name} has no cross-tenant case`),
    ...cases
      .filter((name) => !listed.has(name))
      .map((name) => `${name} is not a repository method`),
  ];
}
