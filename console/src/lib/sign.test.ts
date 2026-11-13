// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { describe, expect, it } from 'vitest';

import type { ConsoleApi } from './api';
import type { Config } from './schemas';
import { TxFailedError, signAndSubmit } from './sign';
import { mockWallet } from './wallet';

const config = { networkPassphrase: 'Test SDF Network ; September 2015' } as Config;
const wallet = mockWallet('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');

function apiAnswering(result: Awaited<ReturnType<ConsoleApi['submitTx']>>): ConsoleApi {
  return { submitTx: () => Promise.resolve(result) } as unknown as ConsoleApi;
}

describe('signAndSubmit', () => {
  it('returns the result of a settled transaction', async () => {
    const api = apiAnswering({ hash: 'ab', status: 'SUCCESS', mandate: 'C1' });
    await expect(signAndSubmit(api, config, wallet, { xdr: 'x' })).resolves.toMatchObject({
      mandate: 'C1',
    });
  });

  it('explains a refused transaction with its reason and keeps the hash', async () => {
    const api = apiAnswering({ hash: 'cd', status: 'FAILED', reason: 'already_paused' });
    const failure = await signAndSubmit(api, config, wallet, { xdr: 'x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TxFailedError);
    expect(failure).toMatchObject({
      hash: 'cd',
      reason: 'already_paused',
      message:
        'The network refused this transaction, so nothing moved. The mandate is already paused.',
    });
  });

  it('still says something useful without a reason', async () => {
    const api = apiAnswering({ hash: 'ef', status: 'FAILED' });
    await expect(signAndSubmit(api, config, wallet, { xdr: 'x' })).rejects.toThrow(
      /Open it on Stellar Expert/,
    );
  });
});
