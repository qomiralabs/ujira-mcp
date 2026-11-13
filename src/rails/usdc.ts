// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// USDC straight to the recipient's Stellar account. The mandate's execute
// transfers the asset to the leg destination, so settling is one execute
// signed by the executor key.

import { EngineError } from '../errors.js';
import { accountAddress } from '../ids.js';
import type { MandateClient } from '../mandate/client.js';
import type { TxSigner } from '../stellar/gateway.js';
import type { PayoutRail, RailPayment, RailSettlement } from './rail.js';

export class UsdcRail implements PayoutRail {
  readonly name = 'usdc' as const;
  private readonly mandate: MandateClient;
  private readonly executor: TxSigner;

  constructor(mandate: MandateClient, executor: TxSigner) {
    this.mandate = mandate;
    this.executor = executor;
  }

  destinationFor(recipient: string): string {
    if (!accountAddress.safeParse(recipient).success) {
      throw new EngineError('input_invalid', 'the usdc rail pays a Stellar account address (G...)');
    }
    return recipient;
  }

  async settle(payment: RailPayment): Promise<RailSettlement> {
    const { txHash } = await this.mandate.execute(this.executor, payment.payoutId);
    return { txHash };
  }
}
