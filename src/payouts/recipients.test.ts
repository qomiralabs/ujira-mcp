// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The parts of the recipient service that need no database. The service
// itself runs against a real one in src/api/routes/recipients.db.test.ts.

import { describe, expect, it } from 'vitest';

import { constraintViolation, type PayoutMethod, type Recipient } from '../db/index.js';
import {
  emailAssociatedData,
  isPayable,
  maskAddress,
  payStatus,
  RecipientError,
  type RecipientView,
} from './recipients.js';

const recipient: Recipient = {
  id: '5a1e9c2d-7b3f-4e8a-a1c2-3d4e5f6a7b8c',
  projectId: '1f4b2b8e-2a8d-4f0f-8c55-6f0e3e2c9b21',
  mandateId: '0b8f6a4c-58c3-4a3b-9f0e-6c1d2e3f4a5b',
  label: 'Ada',
  recipientRef: 'a'.repeat(64),
  status: 'active',
  createdAt: new Date(0),
};

function wallet(destinationStatus: PayoutMethod['destinationStatus']): PayoutMethod {
  return {
    id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
    projectId: recipient.projectId,
    recipientId: recipient.id,
    method: 'stellar_wallet',
    destination: 'GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT',
    verifiedAt: null,
    destinationStatus,
    checkedAt: destinationStatus === 'unchecked' ? null : new Date(0),
    createdAt: new Date(0),
  };
}

describe('payStatus', () => {
  it.each([
    ['receivable', 'active', true],
    ['no_account', 'no_account', false],
    ['no_trustline', 'no_trustline', false],
    ['unchecked', 'unchecked', false],
  ] as const)('reads a %s wallet as %s', (status, expected, payable) => {
    const view: RecipientView = { recipient, method: wallet(status) };
    expect(payStatus(view)).toBe(expected);
    expect(isPayable(view)).toBe(payable);
  });

  it('needs a wallet before anything can be paid', () => {
    expect(payStatus({ recipient, method: null })).toBe('needs_wallet');
    expect(isPayable({ recipient, method: null })).toBe(false);
  });

  it('puts a suspension before any wallet state', () => {
    const view = { recipient: { ...recipient, status: 'suspended' as const }, method: null };
    expect(payStatus(view)).toBe('suspended');
    expect(payStatus({ recipient: view.recipient, method: wallet('receivable') })).toBe(
      'suspended',
    );
  });
});

describe('maskAddress', () => {
  it('keeps four characters at each end, as wallets show an address', () => {
    expect(maskAddress('GBT7ITQKEX3Z2YWIYLPRQ5W3JLA2TJ3JTABB765ZYNG7VLX5YYUPI3DT')).toBe(
      'GBT7...I3DT',
    );
  });

  it('leaves a value too short to hide anything as it is', () => {
    expect(maskAddress('GABC')).toBe('GABC');
  });
});

describe('emailAssociatedData', () => {
  it('names the principal, the project and the recipient', () => {
    const data = emailAssociatedData({ principalId: 'p', projectId: 'q' }, 'r');
    expect(data).toBe('ujira/recipient-email/v1:p:q:r');
    expect(emailAssociatedData({ principalId: 'p', projectId: 'x' }, 'r')).not.toBe(data);
  });
});

describe('RecipientError', () => {
  it('carries its code, the spec error and the cause', () => {
    const cause = new Error('below');
    const error = new RecipientError('MANDATE_REFUSED', 'no', { specError: 'PAUSED', cause });
    expect(error.code).toBe('MANDATE_REFUSED');
    expect(error.specError).toBe('PAUSED');
    expect(error.cause).toBe(cause);
    expect(new RecipientError('LABEL_TAKEN', 'no').cause).toBeUndefined();
  });
});

describe('constraintViolation', () => {
  it.each([
    ['23505', 'unique'],
    ['23503', 'foreign_key'],
    ['23514', 'check'],
    ['23502', 'not_null'],
  ] as const)('reads SQLSTATE %s as a %s violation with its constraint', (code, kind) => {
    expect(constraintViolation({ code, constraint: 'c' })).toEqual({ kind, constraint: 'c' });
  });

  it('answers undefined for anything that is not a constraint violation', () => {
    expect(constraintViolation({ code: '40001' })).toBeUndefined();
    expect(constraintViolation(new Error('x'))).toBeUndefined();
    expect(constraintViolation(null)).toBeUndefined();
    expect(constraintViolation('23505')).toBeUndefined();
    expect(constraintViolation({ code: 23505 })).toBeUndefined();
  });

  it('leaves the constraint out when the driver gave none', () => {
    expect(constraintViolation({ code: '23505' })).toEqual({
      kind: 'unique',
      constraint: undefined,
    });
  });
});
