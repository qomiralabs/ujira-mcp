// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// The one path every wallet action takes: the server builds the transaction,
// the wallet signs it, the server submits it and waits for the result.

import type { ConsoleApi, TxAction } from './api';
import type { Config, SubmitResult, UnsignedTx } from './schemas';
import type { Wallet } from './wallet';

export class TxFailedError extends Error {
  readonly hash: string;

  constructor(hash: string) {
    super(
      'The network refused this transaction. Nothing moved. Open it on Stellar Expert to see why.',
    );
    this.name = 'TxFailedError';
    this.hash = hash;
  }
}

export async function signAndSubmit(
  api: ConsoleApi,
  config: Config,
  wallet: Wallet,
  tx: UnsignedTx,
): Promise<SubmitResult> {
  const signed = await wallet.sign(tx.xdr, {
    networkPassphrase: config.networkPassphrase,
    ...(tx.description === undefined ? {} : { description: tx.description }),
  });
  const result = await api.submitTx(signed);
  if (result.status !== 'SUCCESS') throw new TxFailedError(result.hash);
  return result;
}

export async function buildSignSubmit(
  api: ConsoleApi,
  config: Config,
  wallet: Wallet,
  action: TxAction,
  params: Record<string, unknown>,
): Promise<SubmitResult> {
  const tx = await api.buildTx(action, wallet.address, params);
  return signAndSubmit(api, config, wallet, tx);
}
