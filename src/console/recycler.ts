// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Sends what test recipients received back to the faucet treasury, so a
// public demo keeps paying for itself. It only ever touches wallets in the
// TestWalletStore, which holds only wallets this server made; any other
// address has no key here and cannot be swept.
//
// Each wallet pays its own fee from the test XLM friendbot gave it. A wallet
// that fails is logged and tried again on the next round; one bad wallet
// never stops the others.

import { Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { formatUnits } from '../money.js';
import { TESTNET_PASSPHRASE } from '../stellar/gateway.js';
import type { ConsoleChain } from './chain.js';
import { ApiError } from './errors.js';
import { mapLimit } from './mandates.js';
import { INCLUSION_FEE } from './txbuild.js';
import type { TestWalletStore } from './wallets.js';

/** Wallets looked at per round, so thousands of them never flood Horizon. */
export const RECYCLE_BATCH = 200;
const CONCURRENCY = 4;

export interface RecyclerOptions {
  readonly wallets: TestWalletStore;
  readonly chain: ConsoleChain;
  readonly usdc: { readonly code: string; readonly issuer: string };
  /** Where the USDC goes: the faucet treasury's address. */
  readonly treasury: string;
  readonly log: (line: string) => void;
  readonly batch?: number;
}

export interface Swept {
  readonly address: string;
  readonly amount: bigint;
  readonly hash: string;
}

export interface RoundResult {
  readonly checked: number;
  readonly swept: Swept[];
  readonly failed: number;
}

function codeOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return 'internal_error';
}

export class Recycler {
  private readonly o: RecyclerOptions;
  private readonly batch: number;
  private cursor = 0;
  private running: Promise<RoundResult> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RecyclerOptions) {
    this.o = options;
    this.batch = options.batch ?? RECYCLE_BATCH;
  }

  /** The next slice of wallets, round robin, so every wallet gets its turn. */
  private nextBatch(): string[] {
    const all = this.o.wallets.list().map((w) => w.address);
    if (all.length <= this.batch) {
      this.cursor = 0;
      return all;
    }
    const start = this.cursor % all.length;
    const out: string[] = [];
    for (let i = 0; i < this.batch; i++) {
      const next = all[(start + i) % all.length];
      if (next !== undefined) out.push(next);
    }
    this.cursor = (start + this.batch) % all.length;
    return out;
  }

  private async sweep(address: string): Promise<Swept | undefined> {
    const view = await this.o.chain.account(address, this.o.usdc);
    if (!view.exists || view.usdc === null || view.usdc <= 0n) return undefined;
    const tx = new TransactionBuilder(await this.o.chain.loadAccount(address), {
      fee: INCLUSION_FEE,
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: this.o.treasury,
          asset: new Asset(this.o.usdc.code, this.o.usdc.issuer),
          amount: formatUnits(view.usdc),
        }),
      )
      .setTimeout(60)
      .build();
    if (!this.o.wallets.sign(address, tx)) return undefined;
    const sent = await this.o.chain.submit(tx);
    if (sent.status !== 'SUCCESS') {
      throw new ApiError(502, 'recycle_failed', `the recycle payment failed (${sent.hash})`);
    }
    return { address, amount: view.usdc, hash: sent.hash };
  }

  /** One pass over the next batch; overlapping calls share the pass in flight. */
  runOnce(): Promise<RoundResult> {
    if (this.running !== undefined) return this.running;
    const round = (async () => {
      const batch = this.nextBatch();
      let failed = 0;
      const results = await mapLimit(batch, CONCURRENCY, async (address) => {
        try {
          const swept = await this.sweep(address);
          if (swept !== undefined) {
            this.o.log(
              `recycled ${formatUnits(swept.amount)} USDC from test wallet ${address} to the faucet: ${swept.hash}`,
            );
          }
          return swept;
        } catch (error) {
          failed++;
          this.o.log(`recycle of test wallet ${address} failed (${codeOf(error)})`);
          return undefined;
        }
      });
      const swept = results.filter((r): r is Swept => r !== undefined);
      return { checked: batch.length, swept, failed };
    })();
    const settled = round.finally(() => {
      this.running = undefined;
    });
    this.running = settled;
    return settled;
  }

  /** Runs a round every `intervalMs` until stop; the timer never keeps the process alive. */
  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.o.log(`recycle round failed (${codeOf(error)})`);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
