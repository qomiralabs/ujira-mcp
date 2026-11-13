// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// An in-memory mandate behind the SorobanGateway port. It decodes the same
// ScVal arguments the real contract gets and answers in the same shapes, and
// it runs the request checks in the contract's order, so the engine, the
// client and the codec are all exercised without a network.

import { createHash } from 'node:crypto';

import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import { ContractRefusedError, EngineError } from '../src/errors.js';
import { address, i128, struct, u64 } from '../src/mandate/codec.js';
import type {
  InvokeResult,
  SimulateResult,
  SorobanGateway,
  TxLookup,
  TxSigner,
} from '../src/stellar/gateway.js';
import { signerFrom } from '../src/stellar/keys.js';

export const MANDATE = 'CDEEDQ64YS6XHBTWC3QLS5JWOLI3LSO46VDDZE66FW6CZGHZNRDV4GZW';
export const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
export const UNIT = 10_000_000n;

export function testSigner(seed: string): TxSigner {
  return signerFrom(Keypair.fromRawEd25519Seed(createHash('sha256').update(seed).digest()));
}

export const principal = testSigner('principal');
export const agent = testSigner('agent');
export const approver = testSigner('approver');
export const executor = testSigner('executor');
export const stranger = testSigner('stranger');
export const feeAddress = testSigner('fee').publicKey;

type Code = number;
const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
const hexOf = (b: unknown) => Buffer.from(b as Uint8Array).toString('hex');

interface Rec {
  payoutId: string;
  agent: string;
  recipientRef: string;
  total: bigint;
  fee: bigint;
  legs: { destination: string; amount: bigint }[];
  status: number;
  createdAt: bigint;
  expiresAt: bigint;
  approvals: string[];
}

export class FakeMandateRpc implements SorobanGateway {
  now = 1_800_000_000n;
  limits = {
    totalBudget: 500n * UNIT,
    perPaymentCap: 50n * UNIT,
    perRecipientDailyCap: 100n * UNIT,
    approvalThreshold: 20n * UNIT,
    payoutTtlSeconds: 86_400n,
    expiresAt: 1_900_000_000n,
  };
  agents = [agent.publicKey];
  approvers = [approver.publicKey];
  executors = [executor.publicKey];
  recipientMode = 1;
  balance = 500n * UNIT;
  spent = 0n;
  pending = 0n;
  committed = 0n;
  paused = false;
  revoked = false;
  allow = new Set<string>();
  daily = new Map<string, bigint>();
  payouts = new Map<string, Rec | { tombstone: number }>();
  paid: { destination: string; amount: bigint }[] = [];
  txs = new Map<string, 'SUCCESS' | 'FAILED'>();
  calls: string[] = [];
  /** Makes the next invoke of this method land but lose its answer. */
  loseAnswerOf: string | undefined;
  private seq = 0;

  allowRecipient(ref: string, destination: string) {
    this.allow.add(`${ref}|${destination}`);
  }

  private configVal(): xdr.ScVal {
    return struct({
      principal: address(principal.publicKey),
      asset: address(ASSET),
      recipient_mode: u32(this.recipientMode),
      agents: xdr.ScVal.scvVec(this.agents.map(address)),
      approvers: xdr.ScVal.scvVec(this.approvers.map(address)),
      approvals_required: u32(1),
      executors: xdr.ScVal.scvVec(this.executors.map(address)),
      limits: struct({
        total_budget: i128(this.limits.totalBudget),
        per_payment_cap: i128(this.limits.perPaymentCap),
        per_recipient_daily_cap: i128(this.limits.perRecipientDailyCap),
        approval_threshold: i128(this.limits.approvalThreshold),
        payout_ttl_seconds: u64(this.limits.payoutTtlSeconds),
        expires_at: u64(this.limits.expiresAt),
      }),
      max_fee_bps: u32(100),
      fee_address: address(feeAddress),
      tenant_tag: xdr.ScVal.scvBytes(Buffer.alloc(32)),
    });
  }

  private free(): bigint {
    const left = this.balance - this.pending - this.committed;
    return left < 0n ? 0n : left;
  }

  private stateVal(): xdr.ScVal {
    return struct({
      spent: i128(this.spent),
      pending: i128(this.pending),
      committed: i128(this.committed),
      balance: i128(this.balance),
      free: i128(this.free()),
      paused: xdr.ScVal.scvBool(this.paused),
      revoked: xdr.ScVal.scvBool(this.revoked),
      expired: xdr.ScVal.scvBool(this.now >= this.limits.expiresAt),
      policy_epoch: u64(0n),
    });
  }

  private payoutVal(id: string): xdr.ScVal {
    const entry = this.payouts.get(id);
    if (entry === undefined) return xdr.ScVal.scvVoid();
    if ('tombstone' in entry) {
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Tombstone'),
        struct({
          payout_id: xdr.ScVal.scvBytes(Buffer.from(id, 'hex')),
          status: u32(entry.tombstone),
        }),
      ]);
    }
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol('Record'),
      struct({
        payout_id: xdr.ScVal.scvBytes(Buffer.from(id, 'hex')),
        agent: address(entry.agent),
        agent_epoch: u32(0),
        recipient_ref: xdr.ScVal.scvBytes(Buffer.from(entry.recipientRef, 'hex')),
        total: i128(entry.total),
        fee: i128(entry.fee),
        legs: xdr.ScVal.scvVec(
          entry.legs.map((l) =>
            struct({ destination: address(l.destination), amount: i128(l.amount) }),
          ),
        ),
        status: u32(entry.status),
        created_at: u64(entry.createdAt),
        expires_at: u64(entry.expiresAt),
        policy_epoch: u64(0n),
        approvals: xdr.ScVal.scvVec(
          entry.approvals.map((a) => struct({ approver: address(a), epoch: u32(0) })),
        ),
      }),
    ]);
  }

  read(contractId: string, method: string, args: readonly xdr.ScVal[]): Promise<xdr.ScVal> {
    this.calls.push(`read:${method}`);
    if (contractId !== MANDATE)
      return Promise.reject(new EngineError('rpc_unavailable', 'no such contract'));
    const a = args.map((v) => scValToNative(v) as unknown);
    switch (method) {
      case 'config':
        return Promise.resolve(this.configVal());
      case 'state':
        return Promise.resolve(this.stateVal());
      case 'daily_used':
        return Promise.resolve(
          struct({ day: u64(this.now / 86_400n), used: i128(this.daily.get(hexOf(a[0])) ?? 0n) }),
        );
      case 'is_allowed':
        return Promise.resolve(xdr.ScVal.scvBool(this.allow.has(`${hexOf(a[0])}|${String(a[1])}`)));
      case 'payout':
        return Promise.resolve(this.payoutVal(hexOf(a[0])));
      default:
        return Promise.reject(new EngineError('rpc_unavailable', `fake has no ${method}`));
    }
  }

  /** The request checks in the contract's order. Returns the error code or the new record. */
  private checkRequest(caller: string, req: Record<string, unknown>): Code | Rec {
    if (!this.agents.includes(caller)) return 10;
    if (this.revoked) return 20;
    if (this.now >= this.limits.expiresAt) return 21;
    if (this.paused) return 22;
    const id = hexOf(req['payout_id']);
    if (this.payouts.has(id)) return 60;
    if (this.now >= (req['deadline'] as bigint)) return 35;
    const total = req['total'] as bigint;
    const fee = req['fee'] as bigint;
    if (total < 1n || fee < 0n) return 30;
    const legs = (req['legs'] as { destination: string; amount: bigint }[]).map((l) => ({
      destination: l.destination,
      amount: l.amount,
    }));
    if (legs.length === 0 || legs.length > 4) return 31;
    if (legs.reduce((s, l) => s + l.amount, 0n) !== total) return 32;
    const ref = hexOf(req['recipient_ref']);
    if (legs.some((l) => !this.allow.has(`${ref}|${l.destination}`))) return 50;
    const charge = total + fee;
    if (charge > this.limits.perPaymentCap) return 41;
    if (charge > this.limits.totalBudget - (this.spent + this.pending + this.committed)) return 40;
    const used = this.daily.get(ref) ?? 0n;
    if (total > this.limits.perRecipientDailyCap - used) return 42;
    if (charge > this.free()) return 43;
    return {
      payoutId: id,
      agent: caller,
      recipientRef: ref,
      total,
      fee,
      legs,
      status: charge >= this.limits.approvalThreshold ? 1 : 2,
      createdAt: this.now,
      expiresAt: this.now + this.limits.payoutTtlSeconds,
      approvals: [],
    };
  }

  simulate(
    _contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    source: string,
  ): Promise<SimulateResult> {
    this.calls.push(`simulate:${method}`);
    const [caller, req] = args.map((v) => scValToNative(v) as unknown);
    if (method !== 'request_payout' || caller !== source) {
      return Promise.reject(
        new EngineError('rpc_unavailable', 'fake simulates request_payout only'),
      );
    }
    const out = this.checkRequest(source, req as Record<string, unknown>);
    if (typeof out === 'number') {
      return Promise.resolve({ ok: false, error: new ContractRefusedError(method, out) });
    }
    return Promise.resolve({ ok: true, returnValue: u32(out.status) });
  }

  private land(): string {
    this.seq += 1;
    const hash = createHash('sha256')
      .update(`tx${String(this.seq)}`)
      .digest('hex');
    this.txs.set(hash, 'SUCCESS');
    return hash;
  }

  private run(method: string, a: unknown[], signer: TxSigner): Code | xdr.ScVal | undefined {
    const caller = String(a[0]);
    if (method !== 'allow_recipients' && caller !== signer.publicKey) return 10;
    switch (method) {
      case 'request_payout': {
        const out = this.checkRequest(caller, a[1] as Record<string, unknown>);
        if (typeof out === 'number') return out;
        this.payouts.set(out.payoutId, out);
        if (out.status === 1) this.pending += out.total + out.fee;
        else this.committed += out.total + out.fee;
        return u32(out.status);
      }
      case 'approve': {
        if (!this.approvers.includes(caller)) return 10;
        const rec = this.payouts.get(hexOf(a[1]));
        if (rec === undefined) return 61;
        if ('tombstone' in rec || rec.status !== 1) return 62;
        rec.approvals.push(caller);
        rec.status = 2;
        this.pending -= rec.total + rec.fee;
        this.committed += rec.total + rec.fee;
        return u32(2);
      }
      case 'execute': {
        if (![...this.agents, ...this.executors, principal.publicKey].includes(caller)) return 10;
        const id = hexOf(a[1]);
        const rec = this.payouts.get(id);
        if (rec === undefined) return 61;
        if ('tombstone' in rec || rec.status !== 2) return 62;
        const used = this.daily.get(rec.recipientRef) ?? 0n;
        if (rec.total > this.limits.perRecipientDailyCap - used) return 42;
        this.committed -= rec.total + rec.fee;
        this.spent += rec.total + rec.fee;
        this.balance -= rec.total + rec.fee;
        this.daily.set(rec.recipientRef, used + rec.total);
        this.paid.push(...rec.legs);
        this.payouts.set(id, { tombstone: 3 });
        return undefined;
      }
      case 'reject': {
        const id = hexOf(a[1]);
        const rec = this.payouts.get(id);
        if (rec === undefined || 'tombstone' in rec) return 62;
        this.pending -= rec.total + rec.fee;
        this.payouts.set(id, { tombstone: 4 });
        return undefined;
      }
      default:
        throw new EngineError('rpc_unavailable', `fake has no ${method}`);
    }
  }

  invoke(
    contractId: string,
    method: string,
    args: readonly xdr.ScVal[],
    signer: TxSigner,
  ): Promise<InvokeResult> {
    this.calls.push(`invoke:${method}`);
    if (contractId !== MANDATE)
      return Promise.reject(new EngineError('rpc_unavailable', 'no such contract'));
    const out = this.run(
      method,
      args.map((v) => scValToNative(v) as unknown),
      signer,
    );
    if (typeof out === 'number') return Promise.reject(new ContractRefusedError(method, out));
    const txHash = this.land();
    if (this.loseAnswerOf === method) {
      this.loseAnswerOf = undefined;
      return Promise.reject(
        new EngineError('submission_unknown', `send ${method} lost its answer`),
      );
    }
    return Promise.resolve({ txHash, ledger: this.seq, returnValue: out });
  }

  transaction(hash: string): Promise<TxLookup> {
    const status = this.txs.get(hash);
    return Promise.resolve(status === undefined ? { status: 'NOT_FOUND' } : { status, ledger: 1 });
  }
}
