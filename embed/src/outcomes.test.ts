// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import { ApiProblem, ApiUnreachable } from './api/client.js';
import { MEMO_UNSUPPORTED, RECEIVABILITY_REASONS } from './api/contract.js';
import { afterProofFailed, afterSaveFailed, receivabilityMessage } from './outcomes.js';

function refused(status: number, code: string, reason?: string): ApiProblem {
  return new ApiProblem({ status, code, ...(reason === undefined ? {} : { reason }) });
}

describe('a refused save', () => {
  it('stops the flow when the token has expired', () => {
    expect(afterSaveFailed(refused(401, 'EMBED_TOKEN_EXPIRED'))).toEqual({ kind: 'expired' });
  });

  it('points at the memo when the address needs one a payout cannot carry', () => {
    expect(afterSaveFailed(refused(422, 'DESTINATION_INVALID', MEMO_UNSUPPORTED))).toEqual({
      kind: 'message',
      key: 'destination.memo.unsupported',
      field: 'memo',
    });
  });

  it('says the address cannot receive for any other refusal of it', () => {
    expect(afterSaveFailed(refused(422, 'DESTINATION_INVALID'))).toMatchObject({
      key: 'destination.refused',
      field: 'answer',
    });
  });

  it('asks to try again for anything else, including no network', () => {
    expect(afterSaveFailed(refused(503, 'DB_UNAVAILABLE'))).toMatchObject({
      key: 'widget.saveFailed',
    });
    expect(afterSaveFailed(new ApiUnreachable('offline'))).toMatchObject({
      key: 'widget.saveFailed',
    });
  });

  it('reads a problem by shape, from a client built from another copy of this code', () => {
    const foreign = { problem: { status: 401, code: 'EMBED_TOKEN_EXPIRED' } };
    expect(afterSaveFailed(foreign)).toEqual({ kind: 'expired' });
  });
});

describe('a refused proof', () => {
  it('has words for every reason a wallet cannot receive', () => {
    for (const reason of RECEIVABILITY_REASONS) {
      const outcome = afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', reason));
      expect(outcome).toMatchObject({ kind: 'message', key: receivabilityMessage(reason) });
    }
  });

  it('falls back to plain words for a reason it does not know', () => {
    expect(
      afterProofFailed(refused(422, 'DESTINATION_NOT_RECEIVABLE', 'SOMETHING_NEW')),
    ).toMatchObject({ key: 'destination.refused' });
  });

  it('names a bad, an expired and an unauthorised signature', () => {
    expect(afterProofFailed(refused(422, 'WALLET_PROOF_INVALID'))).toMatchObject({
      key: 'prove.invalid',
    });
    expect(afterProofFailed(refused(422, 'WALLET_PROOF_EXPIRED'))).toMatchObject({
      key: 'prove.expired',
    });
    expect(afterProofFailed(refused(422, 'WALLET_SIGNER_NOT_AUTHORIZED'))).toMatchObject({
      key: 'receive.signerNotAuthorized',
    });
    expect(afterProofFailed(refused(401, 'EMBED_TOKEN_EXPIRED'))).toEqual({ kind: 'expired' });
    expect(afterProofFailed(new Error('boom'))).toMatchObject({ key: 'widget.saveFailed' });
  });
});
