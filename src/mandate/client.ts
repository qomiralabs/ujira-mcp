// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// A typed client for one mandate contract over the SorobanGateway port.

import type { xdr } from '@stellar/stellar-sdk';

import { ContractRefusedError, EngineError } from '../errors.js';
import type { Hex32 } from '../ids.js';
import type { SorobanGateway, TxLookup, TxSigner } from '../stellar/gateway.js';
import {
  address,
  bytes32,
  decodeBool,
  decodeConfig,
  decodeDailyUsed,
  decodePayoutEntry,
  decodeState,
  decodeU32,
  encodeAllowEntries,
  encodePayoutRequest,
} from './codec.js';
import type { MandateConfigView, MandateStateView, PayoutEntry, PayoutRequest } from './types.js';

export interface StatusTx {
  readonly status: number;
  readonly txHash: string;
}

export type RequestSimulation =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly error: ContractRefusedError };

export class MandateClient {
  readonly contractId: string;
  private readonly gateway: SorobanGateway;

  constructor(gateway: SorobanGateway, contractId: string) {
    this.gateway = gateway;
    this.contractId = contractId;
  }

  async config(): Promise<MandateConfigView> {
    return decodeConfig(await this.gateway.read(this.contractId, 'config', []));
  }

  async state(): Promise<MandateStateView> {
    return decodeState(await this.gateway.read(this.contractId, 'state', []));
  }

  /** What the recipient has been paid today, by the mandate's clock. */
  async dailyUsed(recipientRef: Hex32): Promise<bigint> {
    return decodeDailyUsed(
      await this.gateway.read(this.contractId, 'daily_used', [bytes32(recipientRef)]),
    );
  }

  async isAllowed(recipientRef: Hex32, destination: string): Promise<boolean> {
    const value = await this.gateway.read(this.contractId, 'is_allowed', [
      bytes32(recipientRef),
      address(destination),
    ]);
    return decodeBool(value, 'allowlist answer');
  }

  async payout(payoutId: Hex32): Promise<PayoutEntry | null> {
    return decodePayoutEntry(
      await this.gateway.read(this.contractId, 'payout', [bytes32(payoutId)]),
    );
  }

  /** What the ledger says about a transaction, for cross-checking receipts. */
  transaction(hash: string): Promise<TxLookup> {
    return this.gateway.transaction(hash);
  }

  /** The contract's own verdict on a request, without sending it. */
  async simulateRequest(agent: string, req: PayoutRequest): Promise<RequestSimulation> {
    const result = await this.gateway.simulate(
      this.contractId,
      'request_payout',
      [address(agent), encodePayoutRequest(req)],
      agent,
    );
    if (!result.ok) return result;
    return { ok: true, status: decodeU32(result.returnValue, 'request status') };
  }

  async requestPayout(agent: TxSigner, req: PayoutRequest): Promise<StatusTx> {
    const sent = await this.gateway.invoke(
      this.contractId,
      'request_payout',
      [address(agent.publicKey), encodePayoutRequest(req)],
      agent,
    );
    return { status: this.statusOf(sent.returnValue, 'request_payout'), txHash: sent.txHash };
  }

  /** A human approval. Not exposed as a tool: an approver key belongs to a person. */
  async approve(approver: TxSigner, payoutId: Hex32): Promise<StatusTx> {
    const sent = await this.gateway.invoke(
      this.contractId,
      'approve',
      [address(approver.publicKey), bytes32(payoutId)],
      approver,
    );
    return { status: this.statusOf(sent.returnValue, 'approve'), txHash: sent.txHash };
  }

  async execute(executor: TxSigner, payoutId: Hex32): Promise<{ readonly txHash: string }> {
    const sent = await this.gateway.invoke(
      this.contractId,
      'execute',
      [address(executor.publicKey), bytes32(payoutId)],
      executor,
    );
    return { txHash: sent.txHash };
  }

  async cancel(caller: TxSigner, payoutId: Hex32): Promise<{ readonly txHash: string }> {
    const sent = await this.gateway.invoke(
      this.contractId,
      'cancel',
      [address(caller.publicKey), bytes32(payoutId)],
      caller,
    );
    return { txHash: sent.txHash };
  }

  /** Principal only. Used to set up a demo mandate. */
  async allowRecipients(
    principal: TxSigner,
    entries: readonly { recipientRef: Hex32; destination: string }[],
  ): Promise<{ readonly txHash: string }> {
    const sent = await this.gateway.invoke(
      this.contractId,
      'allow_recipients',
      [encodeAllowEntries(entries)],
      principal,
    );
    return { txHash: sent.txHash };
  }

  private statusOf(value: xdr.ScVal | undefined, method: string): number {
    if (value === undefined) {
      throw new EngineError('rpc_unavailable', `${method} landed without a return value`);
    }
    return decodeU32(value, `${method} status`);
  }
}
