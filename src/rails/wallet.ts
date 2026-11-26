// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// USDC straight to the recipient's Stellar account. The mandate's execute
// transfers the asset to the leg destination, so settling is one execute
// signed by the executor key. Nothing passes through an account UJIRA holds.

import type { MandateContract, TxSigner } from '../chain/adapter.js';
import { EngineError } from '../errors.js';
import { accountAddress } from '../ids.js';
import { WALLET_RAIL, type PayoutRail, type RailPayment, type RailSettlement } from './rail.js';

export class WalletRail implements PayoutRail {
  readonly name = WALLET_RAIL;
  private readonly mandate: MandateContract;
  private readonly executor: TxSigner;
  private readonly named: ReadonlyMap<string, string>;

  /**
   * `recipients` maps names a person can use, such as "alice", to accounts,
   * so an agent can say who to pay without pasting an address. A name only
   * picks the destination; the mandate's allowlist still decides.
   */
  constructor(
    mandate: MandateContract,
    executor: TxSigner,
    recipients: Readonly<Record<string, string>> = {},
  ) {
    this.mandate = mandate;
    this.executor = executor;
    const named = new Map<string, string>();
    for (const [name, wallet] of Object.entries(recipients)) {
      if (!accountAddress.safeParse(wallet).success) {
        throw new EngineError('config_invalid', `recipient ${name} has no valid Stellar account`);
      }
      named.set(name, wallet);
    }
    this.named = named;
  }

  destinationFor(recipient: string): string {
    const named = this.named.get(recipient);
    if (named !== undefined) return named;
    if (!accountAddress.safeParse(recipient).success) {
      throw new EngineError(
        'input_invalid',
        `the ${WALLET_RAIL} rail pays a Stellar account address (G...)`,
      );
    }
    return recipient;
  }

  async settle(payment: RailPayment): Promise<RailSettlement> {
    const { txHash } = await this.mandate.execute(this.executor, payment.payoutId);
    return { txHash };
  }
}
