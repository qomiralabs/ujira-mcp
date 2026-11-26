// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { caseProblems, methodNames } from './cross-tenant.js';

const repositories = {
  payouts: { create: () => undefined, find: () => undefined, LIMIT: 10 },
  receipts: { list: () => undefined },
};

describe('the cross tenant case matrix', () => {
  it('lists every repository method, and nothing that is not a function', () => {
    expect(methodNames(repositories)).toEqual(['payouts.create', 'payouts.find', 'receipts.list']);
  });

  it('passes when every method has a case', () => {
    expect(caseProblems(repositories, ['payouts.create', 'payouts.find', 'receipts.list'])).toEqual(
      [],
    );
  });

  it('names a method with no case, and a case with no method', () => {
    expect(
      caseProblems(repositories, ['payouts.create', 'receipts.list', 'receipts.drop']),
    ).toEqual([
      'payouts.find has no cross-tenant case',
      'receipts.drop is not a repository method',
    ]);
  });
});
