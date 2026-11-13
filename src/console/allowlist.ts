// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Which signed transactions the console relays. It is a public endpoint, so
// it must never become a free relay for anything else: one operation only,
// and only the calls the console itself builds, against the factory, a
// mandate the console created, the USDC contract into such a mandate, or a
// USDC trustline.

import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';

import { TESTNET_PASSPHRASE } from '../stellar/gateway.js';
import { ApiError } from './errors.js';

/** The mandate calls a console owner can make. */
export const MANDATE_METHODS = [
  'allow_recipients',
  'pause',
  'resume',
  'revoke',
  'sweep',
  'approve',
  'reject',
  'withdraw',
] as const;
export type MandateMethod = (typeof MANDATE_METHODS)[number];

export type AllowedTx =
  | {
      readonly kind: 'create';
      readonly principal: string;
    }
  | {
      readonly kind: 'mandate';
      readonly mandate: string;
      readonly method: MandateMethod;
      readonly args: readonly xdr.ScVal[];
    }
  | { readonly kind: 'fund'; readonly mandate: string; readonly amount: bigint }
  | { readonly kind: 'trustline' };

export interface AllowContext {
  readonly factory: string;
  readonly usdc: { readonly code: string; readonly issuer: string; readonly contract: string };
  readonly agent: string;
  readonly executor: string;
  isRegistered(mandate: string): boolean;
}

const notAllowed = (why: string) =>
  new ApiError(400, 'tx_not_allowed', `This server only relays console transactions: ${why}`);

const createConfig = z.object({
  principal: z.string(),
  asset: z.string(),
  agents: z.array(z.string()),
  executors: z.array(z.string()),
});

/** Parses a signed envelope for this network, or refuses it. */
export function parseEnvelope(envelope: string): Transaction {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXdr(envelope, TESTNET_PASSPHRASE);
  } catch {
    throw new ApiError(400, 'invalid_xdr', 'The transaction cannot be read as testnet XDR');
  }
  if (tx instanceof FeeBumpTransaction) throw notAllowed('fee bump envelopes are not relayed');
  return tx;
}

function native(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}

export function classify(tx: Transaction, ctx: AllowContext): AllowedTx {
  if (tx.operations.length !== 1) throw notAllowed('exactly one operation is expected');
  const op = tx.operations[0];
  if (op === undefined) throw notAllowed('exactly one operation is expected');

  if (op.type === 'changeTrust') {
    const line = op.line;
    if (
      'getCode' in line &&
      line.getCode() === ctx.usdc.code &&
      line.getIssuer() === ctx.usdc.issuer
    ) {
      return { kind: 'trustline' };
    }
    throw notAllowed('only a USDC trustline may be added');
  }
  if (op.type !== 'invokeHostFunction') throw notAllowed('this operation type is not relayed');
  const fn = op.func;
  if (fn.type !== 'hostFunctionTypeInvokeContract') {
    throw notAllowed('only contract calls are relayed');
  }
  const call = fn.invokeContract;
  const contract = Address.fromScAddress(call.contractAddress).toString();
  const method = call.functionName.toString();
  const args = call.args;

  if (contract === ctx.factory) {
    if (method !== 'create' || args.length !== 2 || args[0] === undefined) {
      throw notAllowed('only create is relayed to the factory');
    }
    const config = createConfig.safeParse(native(args[0]));
    if (!config.success) throw notAllowed('the mandate configuration cannot be read');
    const c = config.data;
    // A console mandate is one this server can act for; anything else has no business here.
    if (
      c.asset !== ctx.usdc.contract ||
      c.agents.length !== 1 ||
      c.agents[0] !== ctx.agent ||
      c.executors.length !== 1 ||
      c.executors[0] !== ctx.executor
    ) {
      throw notAllowed("the mandate must use USDC and this server's agent and executor keys");
    }
    return { kind: 'create', principal: c.principal };
  }

  if (contract === ctx.usdc.contract) {
    const to = args[1] === undefined ? undefined : native(args[1]);
    const amount = args[2] === undefined ? undefined : native(args[2]);
    if (
      method !== 'transfer' ||
      args.length !== 3 ||
      typeof to !== 'string' ||
      typeof amount !== 'bigint' ||
      !ctx.isRegistered(to)
    ) {
      throw notAllowed('only a USDC transfer into a console mandate is relayed');
    }
    return { kind: 'fund', mandate: to, amount };
  }

  if (ctx.isRegistered(contract)) {
    if (!(MANDATE_METHODS as readonly string[]).includes(method)) {
      throw notAllowed(`${method} is not a console action`);
    }
    return { kind: 'mandate', mandate: contract, method: method as MandateMethod, args };
  }
  throw notAllowed('the contract is not the factory, USDC or a console mandate');
}

/** The allowlist entries an allow_recipients call carries. */
export function allowEntriesOf(args: readonly xdr.ScVal[]): { ref: string; destination: string }[] {
  const first = args[0];
  if (first === undefined) return [];
  const parsed = z
    .array(z.object({ recipient_ref: z.instanceof(Uint8Array), destination: z.string() }))
    .safeParse(native(first));
  if (!parsed.success) return [];
  return parsed.data.map((e) => ({
    ref: Buffer.from(e.recipient_ref).toString('hex'),
    destination: e.destination,
  }));
}
